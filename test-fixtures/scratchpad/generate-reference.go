// Regenerate from the ScratchPad checkout at the source commit below:
// go run /path/to/agent-fabric-sdk/test-fixtures/scratchpad/generate-reference.go
package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"

	"github.com/synadia-ai/scratchpad/api"
	wire "github.com/synadia-ai/scratchpad/api/v2"
	client "github.com/synadia-ai/scratchpad/client/v2"
)

func main() {
	reference := client.Reference{
		Version: 2,
		Creator: "agent://writer/<reply>&\u2028line\u2029end",
		Account: "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
		Target:  wire.Target{Volume: "Replies", CreationID: strings.Repeat("ab", 16)},
		Root:    api.ContentID{1, 2, 3}, Generation: 7, Path: "/replies/1.txt",
		Retention: wire.RetentionHandle{Slot: 2, Generation: 9}, ExpiresAt: 1900000600,
	}
	token, err := client.EncodeReference(reference)
	if err != nil {
		panic(err)
	}
	canonical, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, "sp-ref:"))
	if err != nil {
		panic(err)
	}
	value := struct {
		Source        string           `json:"source"`
		Reference     client.Reference `json:"reference"`
		CanonicalJSON string           `json:"canonical_json"`
		Token         string           `json:"token"`
	}{"synadia-ai/scratchpad@2f59c514c9d8aed39b510eae1abbab8062185ed5", reference, string(canonical), token}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
}
