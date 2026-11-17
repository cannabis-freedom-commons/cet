package research

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// A report about a widely covered case collects hundreds of sources (one had 219, 69 KB), while
// its prose cites a handful. get_report returned all of it, the agent's harness cut the output at
// about 50 KB, and the agent paged through the saved copy with read and grep. Copies of one story
// are cited in long groups ([@1,3,4,…]), so every source there was cited. get_report now shows the
// first sources and those that a sentence cites in a small group (the ones carrying a fact of
// their own), each with its [@n] number; sources_from lists the rest.

const (
	sourcesShownFirst = 10 // sources always shown from the top of the list
	sourcesShortAt    = 20 // lists up to this length are shown whole
	smallCitation     = 3  // a citation of at most this many sources marks each as carrying a fact
	sourcesPageSize   = 40
)

var citationRe = regexp.MustCompile(`\[@([0-9][0-9,\s]*)\]`)

// sourceItems finds the front matter's top-level sources list: the line index of "sources:", and
// each item as its lines. end is the index of the first line after the list.
func sourceItems(lines []string) (start, end int, items [][]string) {
	start = -1
	closing := 0
	for i, l := range lines {
		if i > 0 && l == "---" {
			closing = i
			break
		}
		if l == "sources:" {
			start = i
		}
	}
	if start < 0 || closing == 0 {
		return -1, -1, nil
	}
	end = closing
	for i := start + 1; i < closing; i++ {
		l := lines[i]
		if l != "" && !strings.HasPrefix(l, " ") && !strings.HasPrefix(l, "-") {
			end = i
			break
		}
		if strings.HasPrefix(strings.TrimLeft(l, " "), "- ") && len(l)-len(strings.TrimLeft(l, " ")) <= 2 {
			items = append(items, []string{l})
		} else if len(items) > 0 {
			items[len(items)-1] = append(items[len(items)-1], l)
		}
	}
	return start, end, items
}

// distinctSources are the sources some sentence cites in a group of at most smallCitation.
func distinctSources(body string) map[int]bool {
	cited := map[int]bool{}
	for _, m := range citationRe.FindAllStringSubmatch(body, -1) {
		group := strings.Split(m[1], ",")
		if len(group) > smallCitation {
			continue
		}
		for _, n := range group {
			if v, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
				cited[v] = true
			}
		}
	}
	return cited
}

func shortenSources(text string) string {
	lines := strings.Split(text, "\n")
	start, end, items := sourceItems(lines)
	if len(items) <= sourcesShortAt {
		return text
	}
	body := strings.Join(lines[end:], "\n")
	cited := distinctSources(body)
	out := append([]string{}, lines[:start+1]...)
	var hidden []int
	for i, item := range items {
		n := i + 1
		if n > sourcesShownFirst && !cited[n] {
			hidden = append(hidden, n)
			continue
		}
		out = append(out, fmt.Sprintf("  # [@%d]", n))
		out = append(out, item...)
	}
	out = append(out, fmt.Sprintf("  # %d of %d sources not shown (%s): after the first %d, only those a sentence cites in a group of up to %d are listed. "+
		"List them with get_report and sources_from; find_reports with source_urls tells whether a URL is already one of them.",
		len(hidden), len(items), numberRanges(hidden), sourcesShownFirst, smallCitation))
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n")
}

func sourcePage(text string, from int) string {
	_, _, items := sourceItems(strings.Split(text, "\n"))
	if from > len(items) {
		return fmt.Sprintf("The report has %d sources.", len(items))
	}
	to := min(from+sourcesPageSize-1, len(items))
	var b strings.Builder
	fmt.Fprintf(&b, "Sources %d-%d of %d:\n", from, to, len(items))
	for i := from; i <= to; i++ {
		fmt.Fprintf(&b, "  # [@%d]\n%s\n", i, strings.Join(items[i-1], "\n"))
	}
	if to < len(items) {
		fmt.Fprintf(&b, "More: sources_from %d.\n", to+1)
	}
	return b.String()
}

// numberRanges writes 6, 7, 8, 11 as "6-8, 11".
func numberRanges(ns []int) string {
	var parts []string
	for i := 0; i < len(ns); {
		j := i
		for j+1 < len(ns) && ns[j+1] == ns[j]+1 {
			j++
		}
		if j > i {
			parts = append(parts, fmt.Sprintf("%d-%d", ns[i], ns[j]))
		} else {
			parts = append(parts, strconv.Itoa(ns[i]))
		}
		i = j + 1
	}
	return strings.Join(parts, ", ")
}
