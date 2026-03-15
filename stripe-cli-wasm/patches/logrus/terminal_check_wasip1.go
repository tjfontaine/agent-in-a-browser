//go:build wasip1

package logrus

import "io"

func checkIfTerminal(w io.Writer) bool {
	return false
}
