{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  makeWrapper,
  releaseInfo,
}:
let
  arch = stdenvNoCC.hostPlatform.parsed.cpu.name;
  assets = builtins.filter (
    asset: asset.kind == "desktop" && asset.os == "macos" && asset.arch == arch && asset.format == "zip"
  ) releaseInfo.links;
  asset =
    if builtins.length assets == 1 then
      builtins.head assets
    else
      throw "Caido ${releaseInfo.version}: expected one macOS ${arch} desktop ZIP in the release manifest";
in
stdenvNoCC.mkDerivation {
  pname = "caido-desktop";
  version = releaseInfo.version;

  src = fetchurl {
    url = asset.link;
    hash =
      if asset.hash or null != null then
        "sha512-${asset.hash}"
      else
        throw "Caido ${releaseInfo.version}: the release manifest is missing the download's SHA-512 checksum";
  };

  nativeBuildInputs = [
    unzip
    makeWrapper
  ];
  sourceRoot = "Caido.app";

  # Preserve the upstream app bundle and its code signature.
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/Applications/Caido.app" "$out/bin"
    cp -R . "$out/Applications/Caido.app/"
    makeWrapper "$out/Applications/Caido.app/Contents/MacOS/Caido" \
      "$out/bin/caido-desktop"
    runHook postInstall
  '';

  meta = {
    description = "Caido Desktop web security auditing toolkit";
    homepage = "https://caido.io/";
    changelog = "https://github.com/caido/caido/releases/tag/v${releaseInfo.version}";
    license = lib.licenses.unfree;
    mainProgram = "caido-desktop";
    platforms = [ "aarch64-darwin" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
