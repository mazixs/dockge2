/** The release discovery contract requires uploaded assets for both supported platforms. */
export const releaseAssets = [ "release.json", "release.json.sigstore.json", "docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64", "dockge2-update-linux-amd64.sigstore.json", "dockge2-update-linux-arm64.sigstore.json" ].map(name => ({ name,
    state: "uploaded" }));
