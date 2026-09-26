package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const repository = "mazixs/dockge2"
const protocolVersion = 1
const maxMetadata = 1 << 20

var digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$`)
var imagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.:-]*(?:/[a-z0-9][a-z0-9._-]*)+$`)

// Release is the signed, versioned contract between the publisher and updater.
// Assets are individual allow-listed files: no archive extraction or executable hooks.
type Release struct {
	Format     int               `json:"format"`
	Version    string            `json:"version"`
	Commit     string            `json:"commit"`
	Channel    string            `json:"channel"`
	Image      string            `json:"image"`
	Digest     string            `json:"digest"`
	Platforms  map[string]string `json:"platforms"`
	Assets     map[string]Asset  `json:"assets"`
	MinUpdater int               `json:"minUpdater"`
	MinCompose string            `json:"minCompose"`
	MinEngine  string            `json:"minEngine"`
	MinVersion string            `json:"minVersion"`
	Schema     string            `json:"schema"`
	Legacy     map[string]Legacy `json:"legacy"`
}
type Asset struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Legacy struct {
	ComposeHash string `json:"composeHash"`
	Schema      string `json:"schema"`
}

func decodeStrict(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func parseRelease(data []byte, version string) (Release, error) {
	var r Release
	if len(data) > maxMetadata {
		return r, errors.New("release metadata too large")
	}
	if err := decodeStrict(data, &r); err != nil {
		return r, err
	}
	if r.Format != 1 || r.MinUpdater < 1 || r.MinUpdater > protocolVersion {
		return r, errors.New("release needs a newer updater; use its verified bootstrap")
	}
	if !versionPattern.MatchString(r.Version) || r.Version != version || !commitPattern.MatchString(r.Commit) {
		return r, errors.New("release version or source commit mismatch")
	}
	channel := "stable"
	if strings.Contains(r.Version, "-") {
		channel = "prerelease"
	}
	if r.Channel != channel || !imagePattern.MatchString(r.Image) || !digestPattern.MatchString(r.Digest) {
		return r, errors.New("invalid release source")
	}
	if !hashPattern.MatchString(r.Schema) || !versionPattern.MatchString(r.MinVersion) ||
		!versionPattern.MatchString(r.MinCompose) || !versionPattern.MatchString(r.MinEngine) {
		return r, errors.New("invalid compatibility contract")
	}
	for _, arch := range []string{"amd64", "arm64"} {
		if !digestPattern.MatchString(r.Platforms["linux/"+arch]) {
			return r, errors.New("release is missing a supported platform")
		}
	}
	names := []string{"docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64"}
	if len(r.Assets) != len(names) {
		return r, errors.New("unexpected release assets")
	}
	for _, name := range names {
		a, ok := r.Assets[name]
		if !ok || !hashPattern.MatchString(a.SHA256) || a.Size <= 0 || a.Size > 64<<20 {
			return r, fmt.Errorf("invalid asset: %s", name)
		}
	}
	for v, legacy := range r.Legacy {
		if !versionPattern.MatchString(v) || !hashPattern.MatchString(legacy.ComposeHash) || !hashPattern.MatchString(legacy.Schema) {
			return r, errors.New("invalid legacy import contract")
		}
	}
	return r, nil
}

func fileHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// compareVersion compares supported SemVer versions, including numeric prerelease identifiers.
func compareVersion(a, b string) int {
	aa, bb := versionPattern.FindStringSubmatch(a), versionPattern.FindStringSubmatch(b)
	if aa == nil || bb == nil {
		panic("version must be validated before comparison")
	}
	for i := 1; i <= 3; i++ {
		if len(aa[i]) != len(bb[i]) {
			if len(aa[i]) < len(bb[i]) {
				return -1
			}
			return 1
		}
		if c := strings.Compare(aa[i], bb[i]); c != 0 {
			return c
		}
	}
	if aa[4] == bb[4] {
		return 0
	}
	if aa[4] == "" {
		return 1
	}
	if bb[4] == "" {
		return -1
	}
	x, y := strings.Split(aa[4], "."), strings.Split(bb[4], ".")
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] == y[i] {
			continue
		}
		xi, xe := strconv.ParseUint(x[i], 10, 64)
		yi, ye := strconv.ParseUint(y[i], 10, 64)
		if xe == nil && ye == nil {
			if xi < yi {
				return -1
			}
			return 1
		}
		if xe == nil {
			return -1
		}
		if ye == nil {
			return 1
		}
		return strings.Compare(x[i], y[i])
	}
	if len(x) < len(y) {
		return -1
	}
	return 1
}

type releaseClient struct {
	client   *http.Client
	run      runner
	verifier string
	env      []string
}

// persistVerifierRoot gives Cosign a home under the installation's state, so its trust
// root outlives a one-shot update container and the host and the panel's helper share it.
// Before the state directory exists (fresh installation, legacy import) Cosign keeps the
// inherited home.
func (c *releaseClient) persistVerifierRoot(state string) error {
	if !exists(state) {
		return nil
	}
	home := filepath.Join(state, "cosign")
	if err := privateDir(home); err != nil {
		return err
	}
	// sigstore-go caches under $HOME/.sigstore/root; TUF_ROOT points the older client there too.
	c.env = []string{"HOME=" + home, "TUF_ROOT=" + filepath.Join(home, ".sigstore", "root")}
	return nil
}

func newReleaseClient(run runner, verifier string) releaseClient {
	return releaseClient{client: &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || req.URL.Scheme != "https" {
			return errors.New("unsafe release redirect")
		}
		return nil
	}}, run: run, verifier: verifier}
}
func (c releaseClient) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := c.client.Do(req)
	if err != nil {
		return nil, errors.New("release download failed; check connectivity")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("release download returned HTTP %d; nothing will be built", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("incomplete or oversized release download")
	}
	return data, nil
}
func (c releaseClient) latest(ctx context.Context) (string, error) {
	data, err := c.get(ctx, "https://api.github.com/repos/"+repository+"/releases/latest", maxMetadata)
	if err != nil {
		return "", err
	}
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if json.Unmarshal(data, &release) != nil || release.Draft || release.Prerelease {
		return "", errors.New("no eligible stable release")
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if !versionPattern.MatchString(version) || strings.Contains(version, "-") {
		return "", errors.New("invalid stable release tag")
	}
	return version, nil
}
func (c releaseClient) verify(ctx context.Context, path, version string) error {
	_, err := c.run.runEnv(ctx, c.env, c.verifier, "verify-blob", "--bundle", path+".sigstore.json",
		"--certificate-identity", "https://github.com/"+repository+"/.github/workflows/release.yml@refs/tags/v"+version,
		"--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", path)
	if err != nil {
		return errors.New("release signature verification failed (expected tagged Dockge2 release workflow)")
	}
	return nil
}

// stage authenticates metadata before trusting its fields or downloading executable assets.
func (c releaseClient) stage(ctx context.Context, version, source, dest string) (Release, error) {
	var result Release
	if !versionPattern.MatchString(version) {
		return result, errors.New("an exact release version is required")
	}
	if err := os.MkdirAll(dest, 0700); err != nil {
		return result, err
	}
	fetch := func(name string, limit int64) ([]byte, error) {
		if source != "" {
			return readRegular(filepath.Join(source, name), limit)
		}
		return c.get(ctx, "https://github.com/"+repository+"/releases/download/v"+version+"/"+name, limit)
	}
	for _, name := range []string{"release.json", "release.json.sigstore.json"} {
		data, err := fetch(name, maxMetadata)
		if err != nil {
			return result, err
		}
		if err = atomicWrite(filepath.Join(dest, name), data, 0600); err != nil {
			return result, err
		}
	}
	if err := c.verify(ctx, filepath.Join(dest, "release.json"), version); err != nil {
		return result, err
	}
	data, err := readRegular(filepath.Join(dest, "release.json"), maxMetadata)
	if err != nil {
		return result, err
	}
	result, err = parseRelease(data, version)
	if err != nil {
		return result, err
	}
	for _, name := range []string{"docker-compose.yml", "install.sh", "dockge2-update-linux-" + runtime.GOARCH} {
		asset := result.Assets[name]
		data, err := fetch(name, asset.Size)
		if err != nil {
			return result, err
		}
		if int64(len(data)) != asset.Size || fileHash(data) != asset.SHA256 {
			return result, fmt.Errorf("release asset hash mismatch: %s", name)
		}
		mode := os.FileMode(0600)
		if name != "docker-compose.yml" {
			mode = 0700
		}
		if err = atomicWrite(filepath.Join(dest, name), data, mode); err != nil {
			return result, err
		}
	}
	return result, nil
}
