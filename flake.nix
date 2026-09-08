{
  description = "worldline: offline-first client layer and server submodule for SpacetimeDB";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # The supported system list as an input, so a consumer can narrow or extend it
    # with `--override-input systems` instead of editing this file.
    systems.url = "github:nix-systems/default";
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      ...
    }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs (import systems) (
          system:
          f (
            import nixpkgs {
              inherit system;
              # SpacetimeDB is BSL 1.1, which nixpkgs classifies as unfree.
              config.allowlistedLicenses = [ nixpkgs.lib.licenses.bsl11 ];
            }
          )
        );
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          # Official prebuilt binaries (see nix/spacetimedb.nix for why not pkgs.spacetimedb).
          spacetimedb = pkgs.callPackage ./nix/spacetimedb.nix { };
        in
        {
          default = pkgs.mkShell {
            packages = [
              spacetimedb
            ]
            ++ (with pkgs; [
              # JavaScript toolchain: library, test module, demo app, vitest.
              nodejs
              pnpm
              bun

              # Task runner
              just

              # wasm-opt: `spacetime build` optimizes modules with it.
              binaryen

              # Linters & formatters
              actionlint
              nixfmt
              statix
              deadnix
              typos

              # General tooling
              git
              jq

              # Headless browsers for packages/browser-tests (Playwright 1.61.x build).
              playwright-driver.browsers
            ]);

            # Playwright must use the nix-provided browsers (no downloads, matching driver version).
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

            shellHook = ''
              export PNPM_HOME="$PWD/.pnpm-home"
              export PATH="$PNPM_HOME:$PATH"
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
