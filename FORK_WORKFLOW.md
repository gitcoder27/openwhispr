# OpenWhispr Custom Fork & Sync Workflow Guide

This document explains how to work with this custom OpenWhispr fork on your VPS, how to test changes on your MacBook, and how to pull official upstream releases while keeping custom changes intact.

---

## 1. Repository Architecture & Remotes

This repository is set up with two Git remotes:
- **`origin`**: Your personal GitHub fork (`https://github.com/gitcoder27/openwhispr.git`)
- **`upstream`**: Official OpenWhispr repository (`https://github.com/OpenWhispr/openwhispr.git`)

### Key Branches:
- **`main`**: Pure mirror of the official upstream repository. **Never commit custom modifications directly to `main`**.
- **`custom-mac-build`**: Your active working branch where all your personal features, settings, and UI modifications reside.

---

## 2. Daily Development Workflow (on this VPS)

When you make changes to the codebase in `/home/ubuntu/Development/openwhispr`:

```bash
# 1. Make sure you are on your working branch
git checkout custom-mac-build

# 2. Check changed files
git status

# 3. Stage and commit your changes
git add .
git commit -m "feat: describe your change here"

# 4. Push to your GitHub fork
git push origin custom-mac-build
```

---

## 3. Syncing with New Upstream Releases

When the official OpenWhispr project releases a new version (e.g., `v1.12.0`, `v1.13.0`):

### Step-by-Step Sync Commands:

```bash
# 1. Fetch the latest branches and tags from official upstream
git fetch upstream

# 2. Switch to your local main branch and update it to match upstream
git checkout main
git merge upstream/main --ff-only

# 3. Push the updated main branch to your personal fork
git push origin main

# 4. Switch back to your custom working branch
git checkout custom-mac-build

# 5. Rebase your custom changes on top of the new official release
git rebase main
```

### If Git reports a conflict during rebase:
1. Open the conflicted files indicated by Git and resolve the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
2. Stage the resolved files:
   ```bash
   git add <resolved-file>
   ```
3. Continue the rebase:
   ```bash
   git rebase --continue
   ```
*(Do not commit during a rebase; use `git rebase --continue`)*.

4. Once the rebase is finished, force-push your updated branch to your fork safely:
   ```bash
   git push origin custom-mac-build --force-with-lease
   ```

---

## 4. Testing Your Changes on macOS (MacBook)

To run and test your custom build on your MacBook:

### Initial Setup on MacBook (One-time):
```bash
# Clone your fork
git clone https://github.com/gitcoder27/openwhispr.git
cd openwhispr

# Check out your custom branch
git checkout custom-mac-build

# Install dependencies
npm install
```

### Running in Development Mode (Fastest with hot-reloading):
```bash
npm run dev
```
This launches the Electron app locally on macOS. Any edits will hot-reload immediately.

### Pulling VPS Changes to your MacBook:
Whenever you push changes from the VPS to GitHub:
```bash
git checkout custom-mac-build
git pull origin custom-mac-build
```

---

## 5. Building an Installable `.app` / `.dmg` on macOS

To build the standalone Mac application on your MacBook:

```bash
# Pre-build native helpers and models
npm run prebuild:mac

# Build the macOS DMG
npm run build:mac
```
The compiled `.dmg` will be generated in the `dist/` directory.

---

## Quick Reference Summary

| Task | Command |
|---|---|
| Check remotes | `git remote -v` |
| Check current branch | `git branch` |
| Save & push changes | `git add . && git commit -m "..." && git push` |
| Update from official release | `git fetch upstream && git checkout main && git merge upstream/main && git checkout custom-mac-build && git rebase main` |
| Run dev mode on Mac | `npm run dev` |
