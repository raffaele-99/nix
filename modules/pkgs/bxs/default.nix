{
  lib,
  buildGoModule,
}:
buildGoModule rec {
  pname = "bxs";
  version = "1.0.0";
  src = lib.cleanSource ./.;
  vendorHash = null;
  doCheck = false;
  subPackages = [ "." ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
    "-X main.version=${version}"
  ];

  meta = {
    description = "Brave Search bx wrapper that prints compact, agent-sized results";
    mainProgram = "bxs";
    platforms = lib.platforms.darwin;
  };
}
