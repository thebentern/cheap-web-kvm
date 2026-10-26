// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestMediaProxyOriginAndToken(t *testing.T) {
	var seen bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = true
		if r.URL.Path != "/media" || r.URL.RawQuery != "" || r.Header.Get("X-KVM-Token") != "private-token-12345" || r.Header.Get("Cookie") != "" {
			t.Errorf("unsafe upstream request")
		}
		w.WriteHeader(200)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	handler := mediaProxy(target, "private-token-12345")
	for _, origin := range []string{"", "https://other.example", "http://console.example"} {
		r := httptest.NewRequest("GET", "https://console.example/media", nil)
		r.Header.Set("Origin", origin)
		r.Header.Set("Upgrade", "websocket")
		r.TLS = &tls.ConnectionState{}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 403 || seen {
			t.Fatal("cross-origin request reached device")
		}
	}
	r := httptest.NewRequest("GET", "https://console.example/media?token=attacker", nil)
	r.Header.Set("Origin", "https://console.example")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Cookie", "secret=value")
	r.TLS = &tls.ConnectionState{}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if !seen || w.Code != 200 {
		t.Fatalf("valid proxy request failed: %d", w.Code)
	}
}
