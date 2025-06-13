{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
    ../../../common/home/pentest-packages.nix
  ];
  
  home.packages = with pkgs; [
    wireshark
    burpsuite
    
    obsidian
    
    flameshot
    
    firefox
    chromium
  ];
  
  programs.firefox = {
    enable = true;
    profiles.pentest = {
      id = 0;
      name = "Pentest";
      isDefault = true;
      
      settings = {
        "browser.startup.homepage" = "about:blank";
        "privacy.trackingprotection.enabled" = false;
        "network.proxy.type" = 1;
        "network.proxy.http" = "127.0.0.1";
        "network.proxy.http_port" = 8080;
        "network.proxy.ssl" = "127.0.0.1";
        "network.proxy.ssl_port" = 8080;
        "network.proxy.no_proxies_on" = "localhost,127.0.0.1";
      };
      
      extensions = with pkgs.nur.repos.rycee.firefox-addons; [
        foxyproxy-standard
        user-agent-string-switcher
        cookie-editor
      ];
    };
  };
  
  home.file.".local/bin/start-pentest" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      
      echo "startin"
      
      if ! systemctl is-active docker &>/dev/null; then
        sudo systemctl start docker
      fi
      
      if ! systemctl is-active postgresql &>/dev/null; then
        sudo systemctl start postgresql
      fi
      
      echo "whatever claude"
    '';
  };
}
