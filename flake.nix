{
  description = "worldline: offline-first client layer and server submodule for SpacetimeDB";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
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
            packages =
              [ spacetimedb ]
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
              echo ""
              echo -e "  \033[1;36m@kamadadze/worldline\033[0m"
              echo "  node      $(node --version)   pnpm $(pnpm --version)   bun $(bun --version)"
              echo "  spacetime $(spacetime --version 2>/dev/null | head -n1)"
              echo ""
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
