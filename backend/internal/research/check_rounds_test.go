package research

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The result check names every schema problem at once (one per round cost long runs several
// rounds); Validate still answers with the first.
func TestProblemsListsEverySchemaProblem(t *testing.T) {
	r := Result{Outcome: "new_event", Explanation: "A new enforcement report.", CreatedByModel: "m", Date: "1990-01-01", Country: "zz", Slug: "Bad Slug", Type: "seizure"}
	problems := r.Problems(map[string]bool{"de": true})
	if len(problems) < 3 {
		t.Fatalf("expected the date, the country and the coordinates at least: %v", problems)
	}
	text := ""
	for _, p := range problems {
		text += p.Error() + "\n"
	}
	for _, want := range []string{"invalid incident date", "invalid country or slug", "coordinates and precision are required"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
	if err := r.Validate(map[string]bool{"de": true}); err == nil || err.Error() != problems[0].Error() {
		t.Fatalf("Validate must keep answering with the first problem: %v", err)
	}
	if got := (Result{Outcome: "bogus"}).Problems(nil); len(got) != 1 {
		t.Fatalf("an unknown outcome stops the checks: %v", got)
	}
}

// A change the model split in two is put back together instead of costing a round.
func TestMergeUpdatesFoldsSplitUpdates(t *testing.T) {
	q1, q2 := []string{"Who owned the farm?"}, []string{"Who owned the farm?", "When is the trial?"}
	r := Result{Outcome: "additional_source", ExistingReport: "farm-raid", Facts: []Fact{{Text: "a"}},
		Updates: []ReportUpdate{
			{Report: "farm-raid", Facts: []Fact{{Text: "b"}}},
			{Report: "other-case", Facts: []Fact{{Text: "c"}}, OpenQuestions: &q1},
			{Report: "other-case", Facts: []Fact{{Text: "d"}}, OpenQuestions: &q2, Title: "New title"},
		}}
	r.MergeUpdates()
	if len(r.Facts) != 2 || r.Facts[1].Text != "b" {
		t.Fatalf("the update of the answer's own report must join its facts: %+v", r.Facts)
	}
	if len(r.Updates) != 1 || len(r.Updates[0].Facts) != 2 || r.Updates[0].Title != "New title" || len(*r.Updates[0].OpenQuestions) != 2 {
		t.Fatalf("two updates of one report must become one: %+v", r.Updates)
	}
	conflict := Result{Outcome: "new_event", Updates: []ReportUpdate{{Report: "x-y", Title: "One"}, {Report: "x-y", Title: "Two"}}}
	conflict.MergeUpdates()
	if len(conflict.Updates) != 2 {
		t.Fatal("two different corrections of one title are the model's to settle")
	}
}

// A sentence copied with a small slip is that sentence; one with another figure never is, and the
// error shows the report's closest sentences.
func TestMergeTargetNearSentence(t *testing.T) {
	body := "Police seized 25 kilograms of cannabis at the port on Monday. [@1] Two men were arrested at the scene. [@1]\n\nThe court remanded them. [@2]"
	if s, ok := nearSentence(body, "Police seized 25 kilograms of cannabis at the port on Monday morning."); !ok || !strings.HasPrefix(s, "Police seized 25") {
		t.Fatalf("a near copy must be found: %q %v", s, ok)
	}
	if _, ok := nearSentence(body, "Police seized 35 kilograms of cannabis at the port on Monday."); ok {
		t.Fatal("a sentence with another figure must never be taken for it")
	}
	if _, ok := nearSentence(body, "Police seized 25 kilograms."); ok {
		t.Fatal("a much longer sentence is not the target")
	}
	err := mergeTargetError("port-case", Fact{Text: "Two men were detained."}, "Two men were detained there.", body)
	if !errors.Is(err, ErrMergeTarget) || !strings.Contains(err.Error(), "Two men were arrested at the scene.") || !strings.Contains(err.Error(), "port-case") {
		t.Fatalf("the error must name the report and its closest sentence: %v", err)
	}
}

// Values that only drop out are notes: the check accepts the result instead of asking for another
// round; a real problem still rejects it, with the notes beside it.
func TestCheckNotesDoNotReject(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"outcome": "not_relevant", "explanation": "The page is about something else entirely."})
	notesOnly := func(context.Context, Result) []string { return []string{CheckNote + "details.agencies will be left out"} }
	text, draft, clean := runCheck(context.Background(), raw, notesOnly)
	if !clean || draft == nil || !strings.Contains(text, "accepts this result") || !strings.Contains(text, "details.agencies") {
		t.Fatalf("notes alone must not reject: %v %q", clean, text)
	}
	both := func(context.Context, Result) []string {
		return []string{"schema validation: invalid place", CheckNote + "details.agencies will be left out"}
	}
	text, _, clean = runCheck(context.Background(), raw, both)
	if clean || !strings.Contains(text, "invalid place") || !strings.Contains(text, "also be left out") {
		t.Fatalf("a problem still rejects, with the notes beside it: %q", text)
	}
}
