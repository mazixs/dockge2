// The start period belongs to Docker; the probe reports actual readiness on every run.
package main

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func validateReadiness(response *http.Response, version string) error {
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("not ready: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return errors.New("oversized readiness response")
	}
	var status struct {
		Service  string `json:"service"`
		Protocol int    `json:"protocol"`
		Ready    bool   `json:"ready"`
		Version  string `json:"version"`
	}
	if err = json.Unmarshal(data, &status); err != nil {
		return errors.New("invalid readiness response")
	}
	if status.Service != "dockge2" || status.Protocol != 1 || !status.Ready || status.Version != version || version == "" {
		return errors.New("readiness contract mismatch")
	}
	return nil
}
func probe() error {
	data, err := os.ReadFile("/app/package.json")
	if err != nil {
		return err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err = json.Unmarshal(data, &pkg); err != nil {
		return err
	}
	host := os.Getenv("DOCKGE_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("DOCKGE_PORT")
	if port == "" || strings.HasPrefix(port, "tcp://") {
		port = "5001"
	}
	protocol := "http"
	if os.Getenv("DOCKGE_SSL_KEY") != "" && os.Getenv("DOCKGE_SSL_CERT") != "" {
		protocol = "https"
	}
	// The in-container endpoint may have a private/self-signed certificate.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	client := http.Client{Timeout: 5 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("readiness redirect refused") }}
	response, err := client.Get(protocol + "://" + net.JoinHostPort(host, port) + "/health/ready")
	if err != nil {
		return err
	}
	return validateReadiness(response, pkg.Version)
}
func main() {
	if err := probe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("Dockge2 ready")
}
