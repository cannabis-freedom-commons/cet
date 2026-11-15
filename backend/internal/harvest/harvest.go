// Package harvest sends discovered URLs directly to durable intake, never to public Nostr.
package harvest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/safeurl"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/store"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Collector struct {
	Store          *store.Store
	Feeds, Queries []string
}

func hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func fetch(ctx context.Context, raw string) ([]byte, error) {
	u, err := safeurl.Normalize(raw)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	res, err := safeurl.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("harvest source unavailable")
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
	if err != nil || len(b) > 2*1024*1024 {
		return nil, errors.New("harvest response too large")
	}
	return b, nil
}
func (c Collector) ingest(ctx context.Context, origin, source, raw string) error {
	u, err := safeurl.Normalize(raw)
	if err != nil {
		return nil
	}
	_, err = c.Store.Accept(ctx, store.Intake{Origin: origin, URL: raw, CanonicalURL: u, Provenance: store.JSON(map[string]any{"source": source, "discovered_at": time.Now().Unix()}), IdempotencyKey: origin + ":" + hash(source+"\n"+u)})
	return err
}
func (c Collector) checkpoint(ctx context.Context, key, cursor string) error {
	_, err := c.Store.DB.ExecContext(ctx, "INSERT INTO harvest_state VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at", key, cursor, time.Now().Unix())
	return err
}

type Feed struct {
	Channel struct {
		Items []struct {
			Link string `xml:"link"`
		} `xml:"item"`
	} `xml:"channel"`
	Entries []struct {
		Links []struct {
			Href string `xml:"href,attr"`
			Rel  string `xml:"rel,attr"`
		} `xml:"link"`
	} `xml:"entry"`
}

func ParseFeed(b []byte) ([]string, error) {
	var f Feed
	if err := xml.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	urls := []string{}
	for _, i := range f.Channel.Items {
		urls = append(urls, i.Link)
	}
	for _, e := range f.Entries {
		for _, l := range e.Links {
			if l.Rel == "" || l.Rel == "alternate" {
				urls = append(urls, l.Href)
				break
			}
		}
	}
	if len(urls) > 250 {
		return nil, errors.New("feed exceeds candidate bound")
	}
	return urls, nil
}
func (c Collector) RSS(ctx context.Context, feed string) error {
	b, err := fetch(ctx, feed)
	if err != nil {
		return err
	}
	urls, err := ParseFeed(b)
	if err != nil {
		return err
	}
	for _, u := range urls {
		if err = c.ingest(ctx, "rss", feed, u); err != nil {
			return err
		}
	}
	return c.checkpoint(ctx, "rss:"+hash(feed), time.Now().UTC().Format(time.RFC3339))
}

// DefaultGDELTQueries reach the news in languages Google News has no edition for, so its native
// queries return nothing (tested): GDELT machine-translates the world's news and matches these
// English terms in the translations. One query per region, so a refused one stops only its own.
var DefaultGDELTQueries = []string{
	gdeltQuery("persian", "pashto", "urdu"),
	gdeltQuery("swahili", "amharic", "somali"),
	gdeltQuery("burmese", "khmer", "lao", "sinhalese", "mongolian", "nepali"),
	gdeltQuery("albanian", "macedonian", "georgian", "armenian", "azerbaijani", "kazakh", "uzbek", "kyrgyz", "tajik"),
}

func gdeltQuery(languages ...string) string {
	parts := make([]string, len(languages))
	for i, l := range languages {
		parts[i] = "sourcelang:" + l
	}
	return `(cannabis OR marijuana OR hashish OR ganja OR hemp) (seized OR seizure OR arrested OR smuggling OR raid OR destroyed OR sentenced) (` + strings.Join(parts, " OR ") + ")"
}

func (c Collector) GDELT(ctx context.Context, query string) error {
	key := "gdelt:" + hash(query)
	cursor := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Hour)
	var saved string
	if c.Store.DB.QueryRowContext(ctx, "SELECT cursor FROM harvest_state WHERE provider=?", key).Scan(&saved) == nil {
		parsed, err := time.Parse(time.RFC3339, saved)
		if err != nil {
			return err
		}
		cursor = parsed
	}
	end := cursor.Add(time.Hour)
	if end.After(time.Now().UTC().Add(-time.Hour)) {
		return nil
	}
	urls, full, err := gdeltWindow(ctx, query, cursor, end)
	if err != nil {
		return err
	}
	if full {
		// 250 is the most GDELT lists at once: take the hour in quarters instead
		urls = nil
		for from := cursor; from.Before(end); from = from.Add(15 * time.Minute) {
			if err = gdeltPause(ctx); err != nil {
				return err
			}
			part, full, err := gdeltWindow(ctx, query, from, from.Add(15*time.Minute))
			if err != nil {
				return err
			}
			if full {
				slog.Warn("GDELT quarter-hour still has 250 articles; the rest of it is skipped", "source_id", hash(query), "from", from.Format(time.RFC3339))
			}
			urls = append(urls, part...)
		}
	}
	for _, u := range urls {
		if err = c.ingest(ctx, "gdelt", query, u); err != nil {
			return err
		}
	}
	return c.checkpoint(ctx, key, end.Format(time.RFC3339))
}

// gdeltPace keeps GDELT's limit of one request per five seconds.
var gdeltPace = 6 * time.Second

func gdeltPause(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(gdeltPace):
		return nil
	}
}

// gdeltEndpoint is GDELT's DOC API; gdeltFetch reads it (a test stands in for it).
var (
	gdeltEndpoint = "https://api.gdeltproject.org/api/v2/doc/doc"
	gdeltFetch    = fetch
)

// gdeltWindow lists the articles GDELT has for the query in [from, to); full: as many as it lists.
func gdeltWindow(ctx context.Context, query string, from, to time.Time) ([]string, bool, error) {
	params := url.Values{"query": {query}, "mode": {"artlist"}, "format": {"json"}, "maxrecords": {"250"}, "sort": {"datedesc"}, "startdatetime": {from.Format("20060102150405")}, "enddatetime": {to.Format("20060102150405")}}
	b, err := gdeltFetch(ctx, gdeltEndpoint+"?"+params.Encode())
	if err != nil {
		return nil, false, err
	}
	var response struct {
		Articles []struct {
			URL string `json:"url"`
		} `json:"articles"`
	}
	if err = json.Unmarshal(b, &response); err != nil {
		// GDELT answers a query it refuses with a line of text, not JSON
		return nil, false, fmt.Errorf("GDELT refused the query: %.120s", strings.TrimSpace(string(b)))
	}
	urls := make([]string, 0, len(response.Articles))
	for _, a := range response.Articles {
		urls = append(urls, a.URL)
	}
	return urls, len(urls) >= 250, nil
}
func (c Collector) Run(ctx context.Context) {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			for _, feed := range c.Feeds {
				if feed == "" {
					continue
				}
				run, cancel := context.WithTimeout(ctx, time.Minute)
				err := c.RSS(run, strings.TrimSpace(feed))
				cancel()
				if err != nil {
					slog.Warn("RSS harvest pending", "source_id", hash(feed))
				}
			}
			for _, query := range c.Queries {
				if query == "" {
					continue
				}
				run, cancel := context.WithTimeout(ctx, time.Minute)
				err := c.GDELT(run, strings.TrimSpace(query))
				cancel()
				if err != nil {
					slog.Warn("GDELT harvest pending", "source_id", hash(query), "error", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Minute):
				}
			}
			timer.Reset(15 * time.Minute)
		}
	}
}
