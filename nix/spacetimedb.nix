# SpacetimeDB CLI + standalone server from official prebuilt binaries.
#
# Used instead of nixpkgs' `spacetimedb` because that one is unfree (no binary
# cache) and must be compiled from source, which takes a long time and is
# currently broken on nixos-unstable (rustc 1.97 vs vendored ethnum, E0512).
# Pinned to the same version as the `spacetimedb` npm package this repo uses.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  zlib,
}:

let
  version = "2.10.0";

  sources = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-gnu";
      hash = "sha256-IYgJmrHd5KmgyogzT7EEQOuVCb3K6TtO8RR8embI5wI=";
    };
    aarch64-linux = {
      target = "aarch64-unknown-linux-gnu";
      hash = "sha256-mrdP1wg++iX/Pc8NEDmBWWi9ZJgW4NIQgQwAs60idDA=";
    };
    x86_64-darwin = {
      target = "x86_64-apple-darwin";
      hash = "sha256-L/qKT0F6GcEj8q9Qy6ILQzMcYf4lMGhIORpa1PQnlp0=";
    };
    aarch64-darwin = {
      target = "aarch64-apple-darwin";
      hash = "sha256-m1YUC4ivi6ESd8JPu4F30gGWsZJS7miQOQo6tfJ3Peo=";
    };
  };

  source =
    sources.${stdenv.hostPlatform.system}
      or (throw "spacetimedb: unsupported system ${stdenv.hostPlatform.system}");
in
stdenv.mkDerivation {
  pname = "spacetimedb";
  inherit version;

  src = fetchurl {
    url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-${source.target}.tar.gz";
    inherit (source) hash;
  };

  # The tarball is flat (no top-level directory)
  sourceRoot = ".";

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    (lib.getLib stdenv.cc.cc)
    zlib
  ];

  installPhase = ''
    runHook preInstall
    install -Dm755 spacetimedb-cli $out/bin/spacetime
    install -Dm755 spacetimedb-standalone $out/bin/spacetimedb-standalone
    runHook postInstall
  '';

  meta = {
    description = "Multiplayer application database and server (official prebuilt binaries)";
    homepage = "https://spacetimedb.com";
    changelog = "https://github.com/clockworklabs/SpacetimeDB/releases/tag/v${version}";
    license = lib.licenses.bsl11;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "spacetime";
    platforms = builtins.attrNames sources;
  };
}
