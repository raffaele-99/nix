{
  lib,
  buildGoModule,
  tart,
}:
buildGoModule {
  pname = "tart-external";
  version = "0.1.0";
  src = lib.cleanSource ./.;
  vendorHash = null;
  subPackages = [ "." ];
  env.CGO_ENABLED = 0;
  ldflags = [
    "-s"
    "-w"
    "-X main.tartExecutable=${lib.getExe tart}"
  ];

  meta = {
    description = "Run Tart with VM storage on the External NVME volume";
    mainProgram = "tart";
    platforms = lib.platforms.darwin;
  };
}
