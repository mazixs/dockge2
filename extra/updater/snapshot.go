package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func treeHashes(root string) (map[string]string, error) {
	result := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("snapshot contains a non-regular file")
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		result[rel] = hex.EncodeToString(h.Sum(nil))
		return nil
	})
	return result, err
}
func recordSnapshot(root string) error {
	hashes, err := treeHashes(root)
	if err != nil {
		return err
	}
	return writeJSON(root+".sha256.json", hashes)
}
func verifySnapshot(root string) error {
	b, err := readRegular(root+".sha256.json", 8<<20)
	if err != nil {
		return err
	}
	var expected map[string]string
	if err = decodeStrict(b, &expected); err != nil {
		return err
	}
	actual, err := treeHashes(root)
	if err != nil {
		return err
	}
	a, _ := json.Marshal(actual)
	if string(a) != strings.TrimSpace(stringMustJSON(expected)) {
		return errors.New("snapshot files differ from their recorded hashes")
	}
	return nil
}
func stringMustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func schemaHash(root string) (string, error) {
	entries, err := os.ReadDir(filepath.Join(root, "backend", "migrations"))
	if err != nil {
		return "", err
	}
	names := []string{"backend/auth.ts", "backend/auth-runtime.ts", "backend/auth-access.ts", "package-lock.json"}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".ts") {
			names = append(names, "backend/migrations/"+entry.Name())
		}
	}
	sort.Strings(names)
	var s strings.Builder
	for _, name := range names {
		b, err := readRegular(filepath.Join(root, name), 8<<20)
		if err != nil {
			return "", err
		}
		hash := fileHash(b)
		if name == "package-lock.json" {
			hash, err = dependencyHash(b)
			if err != nil {
				return "", err
			}
		}
		s.WriteString(name + ":" + hash + "\n")
	}
	return fileHash([]byte(s.String())), nil
}

// Ignore release numbering in the lockfile while binding the actual dependency code.
func dependencyHash(data []byte) (string, error) {
	var lock struct {
		Packages map[string]struct {
			Version   string `json:"version"`
			Integrity string `json:"integrity"`
			Resolved  string `json:"resolved"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return "", err
	}
	keys := []string{}
	for key := range lock.Packages {
		if key != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var value strings.Builder
	for _, key := range keys {
		p := lock.Packages[key]
		value.WriteString(key + ":" + p.Version + ":" + p.Integrity + ":" + p.Resolved + "\n")
	}
	return fileHash([]byte(value.String())), nil
}
