package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestReadiness(t *testing.T) {
	for _, v := range []struct {
		name, body string
		status     int
		valid      bool
	}{
		{"ready", `{"service":"dockge2","protocol":1,"ready":true,"version":"1.2.3"}`, 200, true},
		{"wrong version", `{"service":"dockge2","protocol":1,"ready":true,"version":"1.2.4"}`, 200, false},
		{"not ready", `{"service":"dockge2","protocol":1,"ready":false,"version":"1.2.3"}`, 200, false},
		{"html", "<html>error</html>", 200, false}, {"404", "", 404, false}, {"500", "", 500, false}, {"503", "", 503, false},
		{"redirect", "", 302, false}, {"oversize", strings.Repeat(" ", 4097), 200, false},
	} {
		t.Run(v.name, func(t *testing.T) {
			err := validateReadiness(&http.Response{StatusCode: v.status, Body: io.NopCloser(strings.NewReader(v.body))}, "1.2.3")
			if (err == nil) != v.valid {
				t.Fatalf("unexpected readiness: %v", err)
			}
		})
	}
}
