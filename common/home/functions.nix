{ config, pkgs, ... }:
{
  # functions shared across all systems
  home.file.".config/zsh/functions.sh".text = ''
function cls () {
  if [ -n "$1" ]; then
    cd "$1" || return
  fi
  clear
  echo -e "$(pwd):\n"
  ls
}

function cla () {
  if [ -n "$1" ]; then
    cd "$1" || return
  fi
  clear
  echo -e "$(pwd):\n"
  ls -a
}

function cll () {
  if [ -n "$1" ]; then
    cd "$1" || return
  fi
  clear
  echo -e "$(pwd):\n"
  ls -l
}

function clsa () {
  if [ -n "$1" ]; then
    cd "$1" || return
  fi
  clear
  echo -e "$(pwd):\n"
  ls -la
}
  '';
}
