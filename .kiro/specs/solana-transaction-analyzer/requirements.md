# Requirements Document

## Introduction

Opsis is a read-only command-line tool that analyzes Solana transaction signatures and explains what happened, with particular emphasis on why transactions failed. The tool resolves cryptic error codes, names instructions, traces execution flow including cross-program invocations, and presents this information in a clear format. The tool operates deterministically, degrades honestly when information is unavailable, and works fully offline against recorded fixtures.

## Glossary

- **Opsis**: The command-line transaction analyzer tool
- **Transaction_Signature**: A base58-encoded unique identifier for a Solana transaction
- **RPC_Client**: Component that fetches transaction data from a Solana RPC endpoint or fixture
- **Instruction_Tree**: The hierarchical structure of instructions including Cross-Program Invocations
- **CPI**: Cross-Program Invocation - when one program calls another program
- **Anchor_IDL**: Interface Definition Language file that describes Anchor program structure
- **Error_Resolver**: Component that maps error codes to human-readable error messages
- **Analysis_Object**: Normalized internal representation of decoded transaction data
- **Confidence_Marker**: Explicit indicator of decode completeness (full, partial, raw)
- **Text_Renderer**: Component that formats the Analysis_Object for terminal display
- **JSON_Renderer**: Component that formats the Analysis_Object as JSON output
- **Fixture**: Recorded RPC response stored locally for offline testing and operation
- **Golden_Test**: Test that compares actual Analysis_Object output against expected output
- **Address_Lookup_Table**: An on-chain account holding a list of addresses that a versioned (v0) transaction message references by index instead of including the full addresses in the static account key list
- **Loaded_Addresses**: The address lists resolved from Address_Lookup_Tables and reported in transaction metadata, separated into loaded writable addresses and loaded readonly addresses
- **Program_Log**: A message emitted during transaction execution and recorded in the log message array of the transaction metadata
- **Token_Balance_Entry**: An element of the preTokenBalances or postTokenBalances array in transaction metadata, identifying an account index, a mint address, a raw token amount, and a decimals value

## Requirements

### Requirement 1: Parse Transaction Signature Input

**User Story:** As a developer, I want to provide a transaction signature to Opsis, so that I can analyze what happened in that transaction.

#### Acceptance Criteria

1. WHEN a Transaction_Signature that base58-decodes successfully to exactly 64 bytes is provided as a command-line argument, THE Opsis SHALL proceed to transaction analysis
2. IF a Transaction_Signature fails to base58-decode, THEN THE Opsis SHALL write an error message indicating invalid signature format to stderr and terminate with exit code 2
3. IF a Transaction_Signature base58-decodes to a byte length other than 64 bytes, THEN THE Opsis SHALL write an error message indicating invalid signature length to stderr and terminate with exit code 2
4. THE Opsis SHALL accept the Transaction_Signature as the first positional argument after the command name
5. WHEN no Transaction_Signature is provided as a command-line argument, THE Opsis SHALL write usage instructions to stderr and terminate with exit code 2

### Requirement 2: Fetch Transaction Data

**User Story:** As a developer, I want Opsis to retrieve transaction data, so that I can analyze it without manually querying the RPC.

#### Acceptance Criteria

1. WHEN a Transaction_Signature is provided, THE RPC_Client SHALL fetch the transaction data from the configured RPC endpoint within 10 seconds
2. IF the Transaction_Signature format is invalid, THEN THE RPC_Client SHALL return an error indicating invalid signature format
3. WHEN the transaction is not found, THE RPC_Client SHALL return an error indicating the transaction does not exist and THE Opsis SHALL terminate with exit code 3
4. WHEN the RPC request fails due to network issues, THE RPC_Client SHALL return an error indicating network failure and THE Opsis SHALL terminate with exit code 3
5. IF the RPC request exceeds 10 seconds, THEN THE RPC_Client SHALL terminate the request, return an error indicating timeout, and THE Opsis SHALL terminate with exit code 3
6. WHEN a fixture file exists for the Transaction_Signature, THE RPC_Client SHALL attempt to load data from that fixture instead of making a network request
7. WHEN transaction data is successfully retrieved, THE RPC_Client SHALL return the complete transaction including metadata, account keys, and instruction details
8. IF loading an existing fixture file fails due to file corruption, invalid JSON, or insufficient file permissions, THEN THE RPC_Client SHALL return an error identifying the fixture file path and the failure reason, SHALL treat the request as failed without issuing a network request, and THE Opsis SHALL terminate with exit code 3

### Requirement 3: Decode Instruction Tree

**User Story:** As a developer, I want to see the complete instruction execution tree including CPIs, so that I can understand the transaction's execution flow.

#### Acceptance Criteria

1. THE Opsis SHALL decode all top-level instructions from the transaction into records containing program ID, instruction data, and account indices
2. THE Opsis SHALL decode all CPI instructions nested within each top-level instruction into records containing program ID, instruction data, and account indices
3. THE Opsis SHALL preserve hierarchical structure by recording parent instruction reference, nesting depth, and execution order for each instruction in the Analysis_Object
4. THE Opsis SHALL maintain instruction ordering by assigning sequential index values matching transaction appearance order
5. WHEN an instruction cannot be decoded, THE Opsis SHALL record an error indicator and preserve raw instruction bytes in the Analysis_Object
6. THE Opsis SHALL record the Instruction_Tree at whatever nesting depth is present in the transaction metadata and SHALL complete decoding without terminating, raising an error, or truncating the tree based on a nesting depth threshold
7. IF an instruction references a program ID that cannot be resolved from the static account keys and cannot be resolved from the Loaded_Addresses, THEN THE Opsis SHALL record the instruction as successfully decoded with a valid field set to false and a reason field identifying the unresolved program ID, which is a condition distinct from the undecodable instruction case in criterion 5
8. WHEN an instruction references a program ID that is resolved from the Loaded_Addresses, THE Opsis SHALL record the instruction with a valid field set to true

### Requirement 4: Resolve Instruction Names

**User Story:** As a developer, I want instruction names resolved where possible, so that I can understand what each instruction does without manually looking up opcodes.

#### Acceptance Criteria

1. WHEN an Anchor_IDL is available for a program AND the IDL contains a matching instruction discriminator, THE Opsis SHALL resolve the instruction name from the IDL
2. WHEN a built-in decoder exists for a program AND no Anchor_IDL is available, THE Opsis SHALL use the built-in decoder to resolve instruction names
3. WHEN neither an Anchor_IDL nor a built-in decoder is available for a program, THE Opsis SHALL label the instruction as "Unknown" and preserve the raw instruction data in the Analysis_Object
4. THE Opsis SHALL include built-in decoders for System Program (program ID 11111111111111111111111111111111), SPL Token (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA), and SPL Associated Token Account (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL) programs
5. FOR ALL decoded instructions, THE Opsis SHALL attach a Confidence_Marker field with value "full" when instruction name and all parameters are resolved, "partial" when instruction name is resolved but some parameters are not, or "raw" when instruction name cannot be resolved
6. IF both an Anchor_IDL and a built-in decoder are available for a program, THEN THE Opsis SHALL use the Anchor_IDL to resolve instruction names
7. IF an Anchor_IDL exists but does not contain the instruction discriminator, THEN THE Opsis SHALL fall back to the built-in decoder if available, otherwise label as "Unknown"

### Requirement 5: Identify Failing Instructions

**User Story:** As a developer, I want the failing instruction clearly marked, so that I can immediately focus on where the transaction failed.

#### Acceptance Criteria

1. WHEN a transaction error contains an instruction index field, THE Opsis SHALL record the instruction index value in a failing_instruction_index field of the Analysis_Object
2. WHEN a transaction error contains an instruction index field, THE Opsis SHALL mark the top-level instruction at that index with a failed field set to true, because the transaction error payload identifies only a top-level instruction index
3. WHEN a transaction succeeded with no error, THE Opsis SHALL set the failed field to false for all instructions in the Analysis_Object, overriding any previously assigned failed value
4. IF a transaction error contains an instruction index that exceeds the top-level instruction count, THEN THE Opsis SHALL record an error indicator in the Analysis_Object and set failing_instruction_index to the invalid value
5. WHERE Program_Log messages permit attribution of the failure to a nested CPI instruction, THE Opsis SHALL record that attribution in the Analysis_Object with Confidence_Marker "partial"

### Requirement 6: Resolve Error Codes

**User Story:** As a developer, I want error codes translated to human-readable messages, so that I understand why the transaction failed without manually looking up error codes.

#### Acceptance Criteria

1. WHEN an error code value is greater than or equal to 6000, THE Error_Resolver SHALL resolve it against the program's Anchor_IDL by matching the error code to the IDL errors array
2. WHEN an error code value is in the range 2000 to 5999 inclusive, THE Error_Resolver SHALL resolve it against the Anchor framework error table
3. WHEN an error code matches one of the error codes defined in that program's error table for System Program, SPL Token, or SPL Associated Token Account, THE Error_Resolver SHALL resolve it against that program-specific error table
4. WHEN error resolution succeeds, THE Error_Resolver SHALL include both the numeric error code and the resolved error message string in the Analysis_Object
5. WHEN error resolution fails because no Anchor_IDL is available for a user-defined error (6000+), THE Error_Resolver SHALL include the numeric error code with Confidence_Marker "raw" and no error message in the Analysis_Object
6. WHEN error resolution fails because the error code is not found in any error table, THE Error_Resolver SHALL include the numeric error code with Confidence_Marker "raw" and no error message in the Analysis_Object
7. THE Error_Resolver SHALL include the Confidence_Marker field with value "full" when error message is resolved, or "raw" when only the numeric code is available
8. WHEN multiple programs are involved in a transaction, THE Error_Resolver SHALL use the program ID of the failing instruction to select the correct error namespace
9. IF the error code format is invalid or cannot be parsed as an integer, THEN THE Error_Resolver SHALL record a parse error and set Confidence_Marker to "raw"
10. WHEN an error code originates from a program with a known error table AND the error code is absent from that error table, THE Error_Resolver SHALL include the numeric error code with Confidence_Marker "raw" and no error message in the Analysis_Object

### Requirement 7: Report Account Information

**User Story:** As a developer, I want to see account roles and balance changes, so that I can understand how the transaction affected account states.

#### Acceptance Criteria

1. FOR ALL static account keys in the effective account key list defined in Requirement 19, THE Opsis SHALL determine and record whether each static account key is a signer based on the transaction message header
2. FOR ALL static account keys in the effective account key list defined in Requirement 19, THE Opsis SHALL determine and record whether each static account key is writable based on the transaction message header
3. FOR ALL static account keys in the effective account key list defined in Requirement 19, THE Opsis SHALL record a static account key as read-only when the transaction message header contains no writable designation for that static account key
4. THE Opsis SHALL apply the transaction message header signer, writable, and read-only designations to the static account keys only
5. WHERE an address in the effective account key list defined in Requirement 19 is resolved from the loaded writable addresses defined in Requirement 19, THE Opsis SHALL record that address as writable
6. WHERE an address in the effective account key list defined in Requirement 19 is resolved from the loaded readonly addresses defined in Requirement 19, THE Opsis SHALL record that address as read-only
7. THE Opsis SHALL record every address resolved from the Loaded_Addresses defined in Requirement 19 with a signer designation of false, because the signer designation applies to the static account keys only
8. WHEN an account's pre-transaction and post-transaction balances are both present in transaction metadata, THE Opsis SHALL calculate the balance delta as (post-balance minus pre-balance) and record the delta as an integer lamport value in the Analysis_Object
9. WHEN an account's pre-transaction balance is absent and post-transaction balance is present, THE Opsis SHALL record only the post-transaction balance as an integer lamport value in the Analysis_Object with no delta
10. THE Opsis SHALL record every account balance value and every balance delta value in the Analysis_Object as an integer lamport value and SHALL perform no unit conversion at the analysis layer
11. THE Opsis SHALL record the instruction index values that reference each account to associate account information with specific instructions
12. WHEN an Anchor_IDL is available and contains an accounts field matching an instruction's account usage, THE Opsis SHALL resolve account names from the IDL and include them in the Analysis_Object
13. WHEN account name resolution fails or no IDL is available, THE Opsis SHALL record the account with its address only and no resolved name
14. THE Opsis SHALL format and output account addresses as base58-encoded strings

### Requirement 8: Report Compute Unit Usage

**User Story:** As a developer, I want to see compute units consumed per instruction, so that I can identify performance bottlenecks and optimize my programs.

#### Acceptance Criteria

1. THE Opsis SHALL report the compute units consumed by each instruction in the transaction as the non-negative integer value reported by the Solana RPC node
2. IF compute unit data cannot be retrieved from the Solana RPC node, THEN THE Opsis SHALL indicate this with a Confidence_Marker
3. THE Opsis SHALL include both per-instruction compute unit values and total transaction compute units in the Analysis_Object
4. IF an instruction consumes zero compute units, THEN THE Opsis SHALL report the value as 0
5. THE Opsis SHALL report total transaction compute units as the non-negative integer value provided in the transaction metadata, independent of the sum of the per-instruction compute unit values, because transaction-level overhead is not attributed to any individual instruction and the total is therefore not expected to equal the sum of the per-instruction values

### Requirement 9: Maintain Deterministic Output

**User Story:** As a developer, I want identical inputs to produce identical outputs, so that I can trust the tool for regression testing and reproducible analysis.

#### Acceptance Criteria

1. WHEN processing a Transaction_Signature, THE Opsis SHALL produce byte-identical output for inputs with identical Transaction_Signature values
2. THE Opsis SHALL use deterministic serialization where map keys are sorted lexicographically and every numeric value is represented as an integer or as a decimal string
3. THE Opsis SHALL NOT use random number generation in its processing pipeline
4. THE Opsis SHALL NOT call external services that return variable responses for identical requests
5. THE Opsis SHALL NOT include system timestamps, process IDs, or execution duration in the Analysis_Object
6. THE Opsis SHALL NOT depend on file system enumeration order when processing multiple files
7. THE Opsis SHALL produce identical Analysis_Object content when executed with different locale settings, timezone configurations, or operating systems

### Requirement 10: Operate Offline with Fixtures

**User Story:** As a developer, I want to analyze transactions using recorded fixtures, so that I can work offline and avoid RPC rate limits during testing.

#### Acceptance Criteria

1. WHEN a file named <Transaction_Signature>.json exists in the ./fixtures directory, THE RPC_Client SHALL load the transaction data from that file instead of making a network request
2. THE fixture file SHALL contain the verbatim recorded RPC response in JSON format
3. IF loading an existing fixture file fails for any reason, including malformed JSON, file corruption, or insufficient file permissions, THEN THE RPC_Client SHALL return an error identifying the fixture file path and the failure reason, SHALL treat the request as failed without issuing a network request, and THE Opsis SHALL terminate with exit code 3
4. WHEN no fixture file exists for the provided Transaction_Signature, THE RPC_Client SHALL attempt to fetch transaction data from the configured RPC endpoint, which is a condition distinct from the fixture load failure case in criterion 3
5. THE Opsis SHALL produce identical Analysis_Object output whether data comes from a fixture file or live RPC response
6. WHEN running with network connectivity disabled, THE Opsis SHALL successfully analyze any transaction for which a valid fixture file exists

### Requirement 11: Degrade Honestly for Unknown Data

**User Story:** As a developer, I want clear indication when information cannot be decoded, so that I know what is certain and what is unknown.

#### Acceptance Criteria

1. WHEN a program has no available decoder or IDL, THE Opsis SHALL include the text "Unknown program" in the instruction's metadata field and preserve the raw instruction data as a hexadecimal string in the Analysis_Object
2. FOR ALL decoded data elements in the Analysis_Object, THE Opsis SHALL attach a Confidence_Marker field with the enumerated value "full", "partial", or "raw"
3. WHEN instruction decoding partially succeeds, THE Opsis SHALL set Confidence_Marker to "partial", include successfully decoded fields in a decoded_fields object, and include remaining undecoded bytes as a hexadecimal string in an undecoded_data field
4. THE Opsis SHALL NEVER omit the Confidence_Marker field from any decoded data element in the Analysis_Object
5. WHEN displaying raw instruction data, THE Opsis SHALL format it as a hexadecimal string prefixed with "0x" and include a label field with value "raw_instruction_data"
6. IF raw instruction data exceeds 256 bytes, THEN THE Opsis SHALL truncate the hexadecimal output at 256 bytes and append the text "... (truncated)" to indicate data was truncated
7. IF a decoder or IDL lookup fails with an error, THEN THE Opsis SHALL record the error reason in an error_detail field and set Confidence_Marker to "raw"

### Requirement 12: Render Analysis as Text

**User Story:** As a developer, I want transaction analysis formatted for terminal display, so that I can read it in my normal development workflow.

#### Acceptance Criteria

1. THE Text_Renderer SHALL format the Analysis_Object into terminal output with labeled sections for transaction metadata, instruction tree, and account states separated by blank lines
2. THE Text_Renderer SHALL use 2-space indentation per hierarchy level to represent the Instruction_Tree structure
3. WHEN the Analysis_Object contains a failing instruction, THE Text_Renderer SHALL highlight that instruction using a color visually distinct from non-failing instructions
4. THE Text_Renderer SHALL use a different color for each of the following categories: instruction types, account roles, error messages, and failing instructions, such that no two categories share the same color
5. THE Text_Renderer SHALL convert each integer lamport value in the Analysis_Object to SOL for display and emit the converted value as a decimal string with exactly 9 fractional digits, computed using integer division and string padding, with thousand separators applied to the integer portion, and SHALL format compute units as integers with thousand separators
6. WHEN terminal color support is not available, THE Text_Renderer SHALL use text markers consisting of "[FAIL]" prefix for failing instructions, "[ERROR]" prefix for error messages, and uppercase labels for account roles
7. IF the Analysis_Object is empty or malformed, THEN THE Text_Renderer SHALL write an error message indicating the rendering failure to stderr
8. THE Text_Renderer SHALL determine color support before applying color formatting by evaluating the following conditions in order: IF the NO_COLOR environment variable is set, THEN color is disabled; otherwise IF stdout is not a TTY, THEN color is disabled; otherwise color is enabled when the COLORTERM environment variable is set or the TERM environment variable indicates a color-capable terminal
9. WHEN the evaluation defined in criterion 8 disables color, THE Text_Renderer SHALL use the text markers defined in criterion 6
10. THE Text_Renderer SHALL convert integer lamport values to SOL using integer arithmetic and string operations only, and SHALL NOT use floating-point division or floating-point arithmetic for that conversion
11. THE Text_Renderer SHALL convert each raw token base-unit amount recorded per Requirement 20 to a decimal string using integer division and string padding, where the number of fractional digits equals the decimals value recorded for that amount's mint per Requirement 20, in contrast to the fixed 9 fractional digits applied to lamport values in criterion 5
12. THE Text_Renderer SHALL format token amounts using integer arithmetic and string operations only, and SHALL NOT use floating-point division or floating-point arithmetic for token amount formatting
13. IF the decimals value is absent from the transaction metadata for a mint, THEN THE Text_Renderer SHALL render the raw base-unit integer amount for that mint, label the rendered value as base units, and attach Confidence_Marker "partial" to that rendered value
14. THE Text_Renderer SHALL derive the fractional digit count of a token amount from the decimals value recorded for that amount's mint per Requirement 20 only, and SHALL NOT substitute a default decimals value, infer a decimals value, or apply the fixed 9 fractional digit lamport rule defined in criterion 5 to any token amount

### Requirement 13: Render Analysis as JSON

**User Story:** As a developer, I want transaction analysis as structured JSON, so that I can process it programmatically or integrate it with other tools.

#### Acceptance Criteria

1. WHEN the JSON output flag is provided, THE JSON_Renderer SHALL format the Analysis_Object as valid JSON conforming to RFC 8259
2. WHEN the JSON output flag is provided, THE JSON_Renderer SHALL encode the output using UTF-8 character encoding
3. THE JSON_Renderer SHALL preserve all fields from the Analysis_Object including Confidence_Markers, transaction details, and analysis results
4. WHEN formatting is complete, THE JSON_Renderer SHALL produce output parseable by any RFC 8259 compliant JSON parser without errors
5. THE JSON_Renderer SHALL NOT include ANSI escape sequences or terminal formatting codes in the output
6. IF the Analysis_Object contains a value that cannot be represented in JSON, THEN THE JSON_Renderer SHALL write an error message indicating serialization failure to stderr
7. WHEN a field is absent from the Analysis_Object, THE JSON_Renderer SHALL omit that field from the output and complete serialization successfully
8. THE JSON_Renderer SHALL emit every account balance value and every balance delta value as a raw integer lamport value and SHALL perform no SOL unit conversion

### Requirement 14: Support Golden File Testing

**User Story:** As a maintainer, I want automated tests that verify correctness against known-good outputs, so that I can detect regressions quickly.

#### Acceptance Criteria

1. THE test suite SHALL discover fixture directories by scanning the designated fixtures directory for subdirectories containing both input.json and expected.json files
2. WHILE testing each discovered fixture, THE test suite SHALL load the input.json file as the RPC response
3. IF input.json is missing or contains invalid JSON, THEN THE test suite SHALL fail that fixture test with an error message indicating the file path and parsing error
4. WHILE testing each discovered fixture, THE test suite SHALL load the expected.json file as the expected Analysis_Object
5. IF expected.json is missing or contains invalid JSON, THEN THE test suite SHALL fail that fixture test with an error message indicating the file path and parsing error
6. WHILE testing each discovered fixture, THE test suite SHALL execute the decode and analysis pipeline using the loaded input.json
7. WHILE testing each discovered fixture, THE test suite SHALL compare the actual Analysis_Object against the expected Analysis_Object using deep equality comparison where field order is ignored and all field values must match exactly
8. WHEN the actual output differs from expected output, THE test suite SHALL fail that fixture test and report the fixture name, the specific fields that differ, and both the expected and actual values for those fields
9. THE test suite SHALL report an overall pass result only when every discovered fixture test passes with network connectivity disabled
10. THE test suite SHALL complete execution of all fixture tests in under 10 seconds on hardware with at least 2 CPU cores and 4GB available RAM
11. WHEN any individual fixture test fails for any reason, including a missing or invalid input.json file, a missing or invalid expected.json file, or an output mismatch, THE test suite SHALL report an overall failure result

### Requirement 15: Read-Only Operation Guarantee

**User Story:** As a security-conscious developer, I want assurance that Opsis never invokes transaction construction, signing, or sending, so that I can use it without risk to my funds.

#### Acceptance Criteria

1. THE Opsis source SHALL NOT contain a call site that constructs a blockchain transaction object, including transfer transactions, program deployment transactions, program interaction transactions, or any state-modifying operation
2. THE Opsis source SHALL NOT contain a call site that performs a cryptographic signing operation using a private key, including EdDSA signing, ECDSA signing, or any signature algorithm used for transaction authentication
3. THE Opsis source SHALL NOT contain a call site that submits a transaction to a blockchain network through an RPC call, a REST API, or any other network protocol
4. THE Opsis source SHALL NOT contain a call site that simulates or estimates the effects of a state-modifying transaction
5. THE Opsis source SHALL NOT contain a call site that requests, accepts, stores, or processes wallet credentials, private keys, seed phrases, mnemonic phrases, or keystore files
6. THE test suite SHALL verify that the Opsis source contains no call site for transaction construction, signing, or sending

### Requirement 16: Configure RPC Endpoint

**User Story:** As a developer, I want to configure which RPC endpoint Opsis uses, so that I can use my preferred RPC provider or local validator.

#### Acceptance Criteria

1. WHEN the --rpc-url flag is provided, THE RPC_Client SHALL send all RPC requests to the specified endpoint
2. WHEN no RPC URL is configured, THE RPC_Client SHALL send all RPC requests to https://api.mainnet-beta.solana.com
3. THE Opsis SHALL accept RPC URL configuration from the environment variable OPSIS_RPC_URL
4. WHEN both --rpc-url flag and OPSIS_RPC_URL environment variable are set, THE Opsis SHALL send all RPC requests to the endpoint specified by the --rpc-url flag
5. THE Opsis SHALL validate the configured RPC URL format before issuing any RPC request, and IF the URL does not conform to the format scheme://host[:port][/path], THEN THE Opsis SHALL write an error message indicating the URL format is invalid to stderr and terminate with exit code 2
6. IF the configured RPC endpoint is unreachable or does not respond within 10 seconds, THEN THE Opsis SHALL write an error message indicating the RPC endpoint cannot be reached to stderr and terminate with exit code 3
7. WHEN the RPC URL is successfully configured, THE Opsis SHALL log the endpoint address being used to stderr

### Requirement 17: Display Version and Help Information

**User Story:** As a developer, I want to see version and usage information, so that I can verify which version I'm running and learn how to use the tool.

#### Acceptance Criteria

1. WHEN the --version flag is provided, THE Opsis SHALL output the current version number to stdout and terminate with exit code 0
2. WHEN the --help flag is provided, THE Opsis SHALL output usage instructions to stdout including command syntax, description of all flags, and at least one usage example, then terminate with exit code 0
3. THE help output SHALL include a description field for each command-line flag indicating its purpose
4. THE help output SHALL include at least one example demonstrating analysis of a transaction signature
5. THE version number displayed SHALL match the value of the version field in package.json
6. IF an unrecognized flag is provided, THEN THE Opsis SHALL write an error message identifying the invalid flag to stderr, write usage instructions to stderr, and terminate with exit code 2
7. WHEN both --version and --help flags are provided, THE Opsis SHALL prioritize --version and output only the version number

### Requirement 18: Load Anchor IDLs

**User Story:** As a developer, I want Opsis to load Anchor IDLs for programs I care about, so that I get detailed instruction and error decoding for those programs.

**Note:** Fetching IDLs from on-chain accounts is out of scope for v1. IDLs are read from a local directory only.

#### Acceptance Criteria

1. THE Opsis SHALL accept IDL directory configuration from the --idl-dir command-line flag
2. WHEN the --idl-dir flag specifies a directory, THE Opsis SHALL load every IDL file with a .json extension from that directory
3. THE Opsis SHALL extract the program ID from the metadata.address field of each loaded IDL file and associate that program ID with that IDL in memory
4. IF an IDL file contains invalid JSON syntax or is missing any of the required Anchor JSON format fields version, name, instructions, or metadata.address, THEN THE Opsis SHALL write a warning message identifying the file path and the failure reason to stderr and continue loading the remaining IDL files

### Requirement 19: Resolve Account Keys for v0 Messages

**User Story:** As a developer, I want Opsis to resolve account keys for versioned transactions, so that account addresses referenced through address lookup tables are reported correctly.

#### Acceptance Criteria

1. THE Opsis SHALL determine the transaction message version from the transaction response and record that version in the Analysis_Object
2. WHEN the message version is legacy, THE Opsis SHALL assemble the effective account key list from the static account keys alone
3. WHEN the message version is v0, THE Opsis SHALL assemble the effective account key list as the static account keys, followed by the loaded writable addresses, followed by the loaded readonly addresses
4. THE Opsis SHALL read the loaded writable addresses and the loaded readonly addresses from the loadedAddresses field of the transaction metadata
5. THE Opsis SHALL resolve each account index in an instruction against the effective account key list assembled in criterion 2 or criterion 3
6. IF the message version is v0 AND the loadedAddresses field is absent from the transaction metadata, THEN THE Opsis SHALL record each account reference with an index beyond the static account key count with Confidence_Marker "raw" and a reason field indicating the Loaded_Addresses are unavailable
7. WHERE an account address is resolved from the Loaded_Addresses, THE Opsis SHALL record a field identifying that the address originated from an Address_Lookup_Table

### Requirement 20: Report SPL Token Balance Deltas

**User Story:** As a developer, I want to see SPL token balance changes per account and mint, so that I can understand how the transaction moved tokens.

#### Acceptance Criteria

1. THE Opsis SHALL read Token_Balance_Entry values from the preTokenBalances and postTokenBalances fields of the transaction metadata
2. THE Opsis SHALL match a pre Token_Balance_Entry to a post Token_Balance_Entry when the account index value and the mint address value are equal
3. WHEN a pre Token_Balance_Entry and a post Token_Balance_Entry are matched, THE Opsis SHALL compute the token balance delta from the raw amount strings of the two entries and record the delta as a decimal string
4. FOR ALL recorded token balance deltas, THE Opsis SHALL record the mint address, the raw amount value, and the decimals value from the Token_Balance_Entry
5. WHEN a Token_Balance_Entry appears in postTokenBalances with no matching entry in preTokenBalances, THE Opsis SHALL record the post raw amount as the delta and set a field indicating the token account was created during the transaction
6. WHEN a Token_Balance_Entry appears in preTokenBalances with no matching entry in postTokenBalances, THE Opsis SHALL record the negated pre raw amount as the delta and set a field indicating the token account was closed during the transaction
7. THE Opsis SHALL compute and represent every token amount and token balance delta using integer arithmetic or decimal string arithmetic
8. THE Opsis SHALL NOT represent any token amount or token balance delta as a floating-point value
9. WHEN the preTokenBalances and postTokenBalances fields are both absent from the transaction metadata, THE Opsis SHALL record an empty token balance delta collection in the Analysis_Object

### Requirement 21: Capture and Associate Program Logs

**User Story:** As a developer, I want program log messages associated with the instructions that emitted them, so that I can trace execution without reading a flat log dump.

#### Acceptance Criteria

1. THE Opsis SHALL read the Program_Log messages from the logMessages field of the transaction metadata and record them in the Analysis_Object
2. THE Opsis SHALL attribute each Program_Log message to an instruction by tracking "invoke" markers to open an instruction scope and "success" markers to close that instruction scope
3. FOR ALL Program_Log attributions derived from the markers defined in criterion 2, THE Opsis SHALL set Confidence_Marker to "partial"
4. WHEN a Program_Log message cannot be attributed to an instruction, THE Opsis SHALL record that message in an unattributed log collection in the Analysis_Object
5. WHEN the transaction metadata indicates the Program_Log messages were truncated, THE Opsis SHALL record a field indicating log truncation and set Confidence_Marker to "partial" for the Program_Log collection
6. WHEN the logMessages field is absent from the transaction metadata, THE Opsis SHALL record an empty Program_Log collection with Confidence_Marker "raw"

### Requirement 22: Define Process Exit Codes and Diagnostic Output Streams

**User Story:** As a developer scripting around Opsis, I want a documented exit code scheme and a predictable split between stdout and stderr, so that I can branch on results and pipe output reliably.

#### Acceptance Criteria

1. WHEN the requested operation completes successfully and the analyzed transaction succeeded on chain, THE Opsis SHALL terminate with exit code 0
2. WHEN the transaction is fetched and analyzed successfully and the analyzed transaction failed on chain, THE Opsis SHALL terminate with exit code 1
3. IF a usage error or an input error occurs, including an invalid Transaction_Signature, an unrecognized flag, a missing Transaction_Signature, or an invalid RPC URL format, THEN THE Opsis SHALL terminate with exit code 2
4. IF a fetch error or a fixture error occurs, including a network failure, a request timeout, an unreachable RPC endpoint, a transaction that does not exist, or a fixture file that fails to load, THEN THE Opsis SHALL terminate with exit code 3
5. THE Opsis SHALL write all diagnostic messages, warning messages, error messages, and usage instructions emitted on an error path to stderr
6. THE Opsis SHALL write only the rendered analysis and explicitly requested output to stdout, where explicitly requested output is the version number produced by the --version flag and the usage instructions produced by the --help flag
