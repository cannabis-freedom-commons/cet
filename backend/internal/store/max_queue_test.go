package store

import (
	"context"
	"fmt"
	"testing"
)

// The queue limit follows MaxQueue, so a discovery target above 1,000 is not cut off at 1,000.
func TestAcceptRefusesOnlyAboveMaxQueue(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	s.MaxQueue = 2
	for i := range 3 {
		u := fmt.Sprintf("https://news.example/queue-%d", i)
		_, err := s.Accept(ctx, Intake{Origin: "web", URL: u, CanonicalURL: u})
		if i < 2 && err != nil {
			t.Fatalf("submission %d refused below the limit: %v", i, err)
		}
		if i == 2 && (err == nil || err.Error() != "queue full") {
			t.Fatalf("submission over the limit: got %v, want queue full", err)
		}
	}
	if (&Store{}).maxQueue() != DefaultMaxQueue {
		t.Fatal("an unset MaxQueue should mean DefaultMaxQueue")
	}
}
