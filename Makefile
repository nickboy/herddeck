.PHONY: test lint schema

test:
	bun test

lint:
	bunx biome check .

# Refresh the committed herdr API schema snapshot (records protocol version)
schema:
	herdr api schema --json > packages/protocol/schema.json
	@jq -r '"captured protocol \(.protocol), schema_version \(.schema_version)"' packages/protocol/schema.json
