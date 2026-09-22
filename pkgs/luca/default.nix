{
  lib,
  buildGoModule,
  installShellFiles,
}:
buildGoModule {
  pname = "luca";
  version = "0.1.0";
  src = lib.cleanSource ./.;
  vendorHash = null;
  doCheck = false;
  subPackages = [ "." ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
  ];
  nativeBuildInputs = [ installShellFiles ];

  postInstall = ''
    installShellCompletion --cmd luca \
      --bash <($out/bin/luca completions bash) \
      --zsh <($out/bin/luca completions zsh) \
      --fish <($out/bin/luca completions fish)
  '';

  meta = {
    description = "Build, activate and update configurable nix-darwin flakes";
    mainProgram = "luca";
    platforms = lib.platforms.darwin;
  };
}
