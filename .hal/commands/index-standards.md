# Index Standards

Rebuild and maintain the standards index file (`.hal/standards/index.yml`).

## Process

### Step 1: Scan for Standards Files

List all `.md` files in `.hal/standards/` and its subfolders. Organize by folder:

```
engine/adapter-structure.md
engine/process-isolation.md
config/template-constants.md
testing/table-driven.md
```

### Step 2: Load Existing Index

Read `.hal/standards/index.yml` if it exists. Note which entries already have descriptions.

### Step 3: Identify Changes

- **New files** — Standards without index entries
- **Deleted files** — Index entries for files that no longer exist
- **Existing files** — Already indexed, keep as-is

### Step 4: Handle New Files

For each new standard:

1. Read the file to understand its content
2. Propose a description:

```
New standard needs indexing:
  File: engine/adapter-structure.md

Suggested description: "Engine file layout and init() self-registration pattern"

Accept? (yes / or type a better description)
```

Keep descriptions to **one short sentence**.

### Step 5: Handle Deleted Files

Remove stale index entries automatically. Report what was removed.

### Step 6: Write Updated Index

Generate `.hal/standards/index.yml`:

```yaml
folder-name:
  file-name:
    description: Brief description here
```

Rules:
- Alphabetize folders, then files within each folder
- File names without `.md` extension
- One-line descriptions only

### Step 7: Report Results

```
Index updated:
  ✓ 2 new entries added
  ✓ 1 stale entry removed
  ✓ 8 entries unchanged

Total: 9 standards indexed
```
