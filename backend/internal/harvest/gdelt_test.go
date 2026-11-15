package harvest

import (
	"context"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/store"
)

// An hour with as many articles as GDELT lists at once is taken in quarters, and the collector
// moves on instead of stopping at that hour for good.
func TestGDELTSplitsAFullHour(t *testing.T) {
	oldFetch, oldPace := gdeltFetch, gdeltPace
	defer func() { gdeltFetch, gdeltPace = oldFetch, oldPace }()
	gdeltPace = time.Millisecond
	var windows []string
	gdeltFetch = func(_ context.Context, raw string) ([]byte, error) {
		u, _ := url.Parse(raw)
		from, _ := time.Parse("20060102150405", u.Query().Get("startdatetime"))
		to, _ := time.Parse("20060102150405", u.Query().Get("enddatetime"))
		windows = append(windows, to.Sub(from).String())
		n := 250
		if to.Sub(from) < time.Hour {
			n = 3
		}
		var items []string
		for i := range n {
			items = append(items, fmt.Sprintf(`{"url":"https://news.example/%s/%d"}`, from.Format("1504"), i))
		}
		return []byte(`{"articles":[` + strings.Join(items, ",") + `]}`), nil
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "t.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	ctx := context.Background()
	c := Collector{Store: s}
	if err := c.GDELT(ctx, DefaultGDELTQueries[0]); err != nil {
		t.Fatal(err)
	}
	if strings.Join(windows, " ") != "1h0m0s 15m0s 15m0s 15m0s 15m0s" {
		t.Fatalf("a full hour must be asked again in quarters: %v", windows)
	}
	var n int
	s.DB.QueryRow("SELECT count(*) FROM submissions WHERE origin='gdelt'").Scan(&n)
	if n != 12 {
		t.Fatalf("the quarters' articles must be queued: %d", n)
	}
	var cursor string
	s.DB.QueryRow("SELECT cursor FROM harvest_state WHERE provider LIKE 'gdelt:%'").Scan(&cursor)
	if cursor == "" {
		t.Fatal("the collector must move past the full hour")
	}
}

// GDELT's answer to a query it refuses is text, not JSON: said in the error, nothing advances.
func TestGDELTRefusedQuery(t *testing.T) {
	old := gdeltFetch
	defer func() { gdeltFetch = old }()
	gdeltFetch = func(context.Context, string) ([]byte, error) { return []byte("Invalid query syntax."), nil }
	if _, _, err := gdeltWindow(context.Background(), "x", time.Now().Add(-2*time.Hour), time.Now().Add(-time.Hour)); err == nil || !strings.Contains(err.Error(), "Invalid query syntax") {
		t.Fatal(err)
	}
}

// The built-in queries reach the languages Google News cannot, and two places missing from every
// query now have one.
func TestDiscoveryReachesMissingPlaces(t *testing.T) {
	all := strings.Join(DefaultGDELTQueries, " ")
	for _, lang := range []string{"persian", "urdu", "swahili", "amharic", "burmese", "albanian", "georgian"} {
		if !strings.Contains(all, "sourcelang:"+lang) {
			t.Fatalf("no GDELT query reaches %s", lang)
		}
	}
	var queries []string
	for _, q := range DefaultGoogleNewsQueries {
		queries = append(queries, q.Query)
	}
	google := strings.Join(queries, "\n")
	for _, place := range []string{"(Eritrea)", `"Sint Maarten"`} {
		if !strings.Contains(google, place) {
			t.Fatalf("no Google News query names %s", place)
		}
	}
}
