package main

import (
	"reflect"
	"testing"
)

func TestActivationUsesBuiltSystemWithoutFlakeEvaluation(t *testing.T) {
	for _, system := range []string{
		"/nix/store/example-darwin-system",
		"/Users/luca/source/checkout with spaces/result",
	} {
		t.Run(system, func(t *testing.T) {
			got := activationCommands("/checkout", system, "/nix/bin/nix-env")
			want := []invocation{
				{
					dir: "/checkout", program: "/usr/bin/sudo",
					args: []string{"-H", "--", "/nix/bin/nix-env", "--profile", "/nix/var/nix/profiles/system", "--set", system},
				},
				{
					dir: "/checkout", program: "/usr/bin/sudo",
					args: []string{"-H", "--", system + "/sw/bin/darwin-rebuild", "activate"},
				},
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("activation commands = %#v, want %#v", got, want)
			}
		})
	}
}
