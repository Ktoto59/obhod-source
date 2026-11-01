// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package main

import (
	"fmt"
	"github.com/spf13/cobra"
)

func init() {
	mainCommand.AddCommand(&cobra.Command{
		Use: "obhod-capabilities", Short: "Print Obhod compatibility features", Args: cobra.NoArgs,
		Run: func(_ *cobra.Command, _ []string) {
			fmt.Println("dns-pool-v1\nredirect-table-31bit\nicmp-idle-log-v1")
		},
	})
}
