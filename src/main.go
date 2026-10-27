package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

//go:embed www/*
var embeddedFiles embed.FS

const (
	certFile = "cert.pem"
	keyFile  = "key.pem"
)

func main() {
	dev := flag.Bool("dev", true, "Serve files from www/ directory instead of embedded files")
	addr := flag.String("addr", ":8443", "HTTPS server address")
	www := flag.String("www", "www", "UI directory (use ../web/.output/public for the Nuxt build)")
	media := flag.String("media", "", "Fixed ESP32 HTTP endpoint, e.g. http://192.168.4.1; token from KVM_MEDIA_TOKEN")
	tlsHosts := flag.String("tls-hosts", "localhost,127.0.0.1", "Comma-separated certificate hostnames/IPs, including laptop LAN IP for tablets")
	flag.Parse()

	// Check and generate certs if needed
	if !fileExists(certFile) || !fileExists(keyFile) {
		fmt.Println("Certificates not found, generating self-signed certificate...")
		if err := generateSelfSignedCert(certFile, keyFile, strings.Split(*tlsHosts, ",")); err != nil {
			log.Fatalf("Failed to generate certificate: %v", err)
		}
	}

	var handler http.Handler
	if *dev {
		fmt.Println("Development mode: serving from www/ directory")
		handler = http.FileServer(http.Dir(*www))
	} else {
		fmt.Println("Production mode: serving embedded files")
		subFS, err := fs.Sub(embeddedFiles, "www")
		if err != nil {
			log.Fatalf("Failed to get sub filesystem: %v", err)
		}
		handler = http.FileServer(http.FS(subFS))
	}

	mux := http.NewServeMux()
	mux.Handle("/", handler)
	if *media != "" {
		target, err := url.Parse(*media)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" || target.User != nil || target.RawQuery != "" || (target.Path != "" && target.Path != "/") {
			log.Fatal("-media must be a fixed http(s)://host[:port] endpoint")
		}
		token := os.Getenv("KVM_MEDIA_TOKEN")
		if len(token) < 16 || len(token) > 80 {
			log.Fatal("Set KVM_MEDIA_TOKEN to the firmware's 16-80 character token")
		}
		mux.Handle("/media", mediaProxy(target, token))
	}

	server := &http.Server{
		Addr:    *addr,
		Handler: mux,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	fmt.Printf("Starting HTTPS server on %s\n", *addr)
	log.Fatal(server.ListenAndServeTLS(certFile, keyFile))
}

func fileExists(filename string) bool {
	info, err := os.Stat(filename)
	return err == nil && !info.IsDir()
}

func generateSelfSignedCert(certPath, keyPath string, hosts []string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	serialNumber, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"cheap-web-kvm"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// Add localhost as SAN
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else if host != "" {
			template.DNSNames = append(template.DNSNames, host)
		}
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	certOut, err := os.Create(certPath)
	if err != nil {
		return err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return err
	}

	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	privBytes := x509.MarshalPKCS1PrivateKey(priv)
	if err := pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: privBytes}); err != nil {
		return err
	}

	return nil
}

// Fixed-target WebSocket tunnel: file data stays in the browser storage worker.
// Only same-origin browser requests may reach the ESP32. The helper injects the
// firmware credential so it never appears in page state or a WebSocket URL.
func mediaProxy(target *url.URL, token string) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
		r.SetURL(target)
		r.Out.URL.Path = "/media"
		r.Out.URL.RawPath = ""
		r.Out.URL.RawQuery = ""
		r.Out.Header.Set("X-KVM-Token", token)
		r.Out.Header.Del("Cookie")
		r.Out.Header.Del("Authorization")
	}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin, err := url.Parse(r.Header.Get("Origin"))
		if err != nil || origin.Host != r.Host || origin.Scheme != "https" || r.TLS == nil || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Method != http.MethodGet {
			http.Error(w, "Same-origin HTTPS WebSocket required", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}
