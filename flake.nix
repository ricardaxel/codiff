{
  description = "Codiff with the assisted-review front end";

  # Same nixpkgs as assisted-review, so both share one closure.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/9bb52223f4f6a0cc606fd0852d8784f896c137d5";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      forSystem =
        pkgs:
        let
          inherit (pkgs) lib;
          # package.json pins Electron 45, newer than any Electron in this nixpkgs: reuse
          # nixpkgs' binary packaging with the upstream release.
          electron =
            pkgs.callPackage "${nixpkgs}/pkgs/development/tools/electron/binary/generic.nix" { }
              "45.2.1"
              {
                x86_64-linux = "616efc1ae4784af1a4f3f0e8774e73e7030e7bd1708da9d09bcf543dfa499beb";
                aarch64-linux = "e04e635e7312f4b361664e18319aefddbcaaebfdee9c8d9a521e520aa8d385bb";
                headers = "09p97lcjgcdlb71q3b6vmhx9xb8m2wpxhw77pinarjprkrgbldli";
              };
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_12;
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.difference ./. (
              lib.fileset.unions [
                (lib.fileset.maybeMissing ./node_modules)
                (lib.fileset.maybeMissing ./dist)
                ./flake.nix
                (lib.fileset.maybeMissing ./flake.lock)
                (lib.fileset.maybeMissing ./.gitlab-ci.yml)
              ]
            );
          };

          codiff = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "codiff";
            version = (lib.importJSON ./package.json).version;
            inherit src;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-1U5CCRoMV5MQshjRLQ81G3KXdMfX/c6mIa5Gnai34cc=";
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
              pkgs.autoPatchelfHook
              pkgs.makeWrapper
              pkgs.pkg-config
              pkgs.python3
            ];
            # Native addons and the prebuilt tool binaries (vite-plus, esbuild, ...).
            buildInputs = [
              pkgs.libxkbfile
              pkgs.xorg.libX11
              pkgs.stdenv.cc.cc.lib
            ];

            env = {
              ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
              # pnpm would otherwise try to download the exact packageManager release.
              npm_config_manage_package_manager_versions = "false";
              # vite-plus re-installs before running a command unless told the deps are fine.
              npm_config_verify_deps_before_run = "false";
            };

            # Musl and other-arch prebuilds in node_modules have nothing to link against.
            autoPatchelfIgnoreMissingDeps = [
              "libc.musl-*.so.1"
            ];

            # After pnpmConfigHook (a postConfigure hook) has installed node_modules.
            preBuild = ''
              # Native addons must match Electron's ABI, not the build Node's.
              export npm_config_runtime=electron npm_config_target=${electron.version} \
                npm_config_nodedir=${electron.headers}
              pnpm rebuild native-keymap node-pty
            '';

            buildPhase = ''
              runHook preBuild
              pnpm exec vp build
              runHook postBuild
            '';

            # shortcut: ships the whole workspace node_modules (dev tools included); prune to
            # production dependencies if the closure size becomes a problem.
            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/codiff $out/bin
              cp -r bin claude codex config core dist electron node_modules opencode package.json pi \
                $out/lib/codiff/
              # Links to the web, service and test workspaces, which are not shipped.
              rm $out/lib/codiff/node_modules/@nkzw/codiff-{web,service,integration-tests}
              # Host libraries in LD_LIBRARY_PATH (e.g. an alsa-lib for another glibc) would be
              # loaded into Electron before its own and crash it at startup.
              makeWrapper ${lib.getExe nodejs} $out/bin/codiff \
                --add-flags $out/lib/codiff/bin/codiff.js \
                --set ELECTRON_OVERRIDE_DIST_PATH ${electron}/bin \
                --unset LD_LIBRARY_PATH \
                --prefix PATH : ${lib.makeBinPath [ pkgs.git ]}
              runHook postInstall
            '';

            passthru = { inherit electron; };
            meta.mainProgram = "codiff";
          });
        in
        {
          inherit codiff;
          default = codiff;
          # The renderer alone, as a static site bundle.
          renderer = pkgs.runCommand "codiff-renderer-${codiff.version}" { } ''
            cp -r ${codiff}/lib/codiff/dist $out
          '';
        };
    in
    {
      packages = eachSystem forSystem;

      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm_12
            pkgs.git
            pkgs.pkg-config
            pkgs.python3
            pkgs.libxkbfile
            pkgs.xorg.libX11
          ];
        };
      });

      checks = eachSystem (pkgs: {
        codiff = self.packages.${pkgs.system}.codiff.overrideAttrs (old: {
          pname = "codiff-tests";
          # Only the assisted-review front end's tests: the rest need network or a display.
          doCheck = true;
          nativeCheckInputs = [ pkgs.git ];
          checkPhase = ''
            runHook preCheck
            pnpm exec vp test electron/__tests__/assisted-review-* core/__tests__/assisted-review.test.ts
            runHook postCheck
          '';
          installPhase = "touch $out";
        });
      });
    };
}
