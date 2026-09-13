{ ... }:
let
  # Native macOS modifier flags; these combinations have no named HM preset.
  shift = 131072;
  control = 262144;
  option = 524288;
  command = 1048576;
  optionCommand = option + command;
  controlCommand = control + command;
  shiftControlCommand = shift + control + command;
in
{
  programs.rectangle = {
    enable = true;
    # Installed system-wide by the shared Darwin package module.
    package = null;

    shortcuts = {
      leftHalf = {
        keyCode = 123; # Left arrow
        modifierFlags = optionCommand;
      };
      rightHalf = {
        keyCode = 124; # Right arrow
        modifierFlags = optionCommand;
      };
      topHalf = {
        keyCode = 126; # Up arrow
        modifierFlags = optionCommand;
      };
      bottomHalf = {
        keyCode = 125; # Down arrow
        modifierFlags = optionCommand;
      };
      topLeft = {
        keyCode = 123;
        modifierFlags = shiftControlCommand;
      };
      topRight = {
        keyCode = 124;
        modifierFlags = shiftControlCommand;
      };
      bottomLeft = {
        keyCode = 123;
        modifierFlags = controlCommand;
      };
      bottomRight = {
        keyCode = 124;
        modifierFlags = controlCommand;
      };
      maximize = {
        keyCode = 3; # F
        modifierFlags = optionCommand;
      };
      restore = {
        keyCode = 51; # Backspace / Delete (not Forward Delete)
        modifierFlags = optionCommand;
      };
    };
  };
}
