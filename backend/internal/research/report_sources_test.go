package research

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestGetReportShortensALongSourceList(t *testing.T) {
	dir := t.TempDir()
	var front strings.Builder
	front.WriteString("title: Player held at Lagos airport\ncountry: ng\ndate: 2026-11-11\nsources:\n")
	for i := 1; i <= 120; i++ {
		fmt.Fprintf(&front, "  - title: Story %d\n    url: https://example.com/story-%d\n    date: 2026-11-15\n", i, i)
	}
	front.WriteString("media:\n  - url: https://example.com/photo.jpg\n")
	writeTestReport(t, dir, "2026/11/lagos-player.md", front.String(),
		"\nThe player was held. [@2] Officers found 32 parcels. [@1,47] Many outlets ran it. [@3,30,60,100] He was charged. [@90]\n")
	l := newReportLookup(dir)

	out := l.get(json.RawMessage(`{"slug":"lagos-player"}`))
	for _, want := range []string{"# [@1]\n  - title: Story 1\n", "# [@10]", "# [@47]\n  - title: Story 47\n", "# [@90]",
		"108 of 120 sources not shown (11-46, 48-89, 91-120)", "media:\n  - url: https://example.com/photo.jpg", "He was charged. [@90]"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in\n%s", want, out)
		}
	}
	if strings.Contains(out, "story-11\n") || strings.Contains(out, "story-30\n") || strings.Contains(out, "Story 120") {
		t.Fatal("a source cited only in a long group was shown", out)
	}

	page := l.get(json.RawMessage(`{"slug":"lagos-player","sources_from":81}`))
	if !strings.Contains(page, "Sources 81-120 of 120") || !strings.Contains(page, "# [@81]\n  - title: Story 81") || strings.Contains(page, "More:") {
		t.Fatal("source page", page)
	}
	if page := l.get(json.RawMessage(`{"slug":"lagos-player","sources_from":1}`)); !strings.Contains(page, "More: sources_from 41.") {
		t.Fatal("first source page", page)
	}

	short := "title: Short\ncountry: br\ndate: 2026-11-04\nsources:\n  - url: https://example.com/a\n"
	writeTestReport(t, dir, "2026/11/short.md", short, "\nText. [@1]\n")
	if out := newReportLookup(dir).get(json.RawMessage(`{"slug":"short"}`)); out != "---\n"+short+"---\n\nText. [@1]\n" {
		t.Fatal("a short report must come back unchanged", out)
	}
}
