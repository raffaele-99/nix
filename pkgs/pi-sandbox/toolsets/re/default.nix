{
  nixpkgsRev ? throw "re-tools requires pkgs or a pinned nixpkgsRev",
  pkgs ? import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${nixpkgsRev}.tar.gz";
  }) { system = "aarch64-linux"; },
}:
let
  jadx = (pkgs.jadx.override { quark-engine = pkgs.emptyDirectory; }).overrideAttrs (old: {
    # Bound Gradle/Kotlin memory and concurrency for the small Linux VM.
    preBuild =
      (old.preBuild or "")
      + "\n"
      + ''
        gradleFlagsArray+=(
          "--max-workers=1"
          "-Dorg.gradle.jvmargs=-Xmx512m -XX:MaxMetaspaceSize=384m"
          "-Pkotlin.compiler.execution.strategy=in-process"
        )
      '';
  });
in
pkgs.symlinkJoin {
  name = "re-tools";
  paths = [
    pkgs.ghidra
    # The optional Quark Engine integration pulls in a large Python/analytics
    # stack. Keep the decompiler usable in the small sandbox VM.
    jadx
    pkgs.radare2
    pkgs.ipsw
  ];
  meta = {
    description = "Reverse engineering tools for opt-in Pi sandbox sessions";
    platforms = [ "aarch64-linux" ];
  };
}
