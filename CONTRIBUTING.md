# Contributing to Happy

Thanks for your interest in contributing to Happy! This guide will help you get started.

## Project Structure

Happy is a monorepo with the following packages:

| Package | Description |
|---------|-------------|
| `packages/happy-app` | Mobile & web app (React Native / Expo) |
| `packages/happy-cli` | CLI daemon that bridges Claude Code to the app |
| `packages/happy-server` | Self-hosted server |
| `packages/happy-wire` | Shared protocol types |
| `packages/happy-agent` | Agent utilities |
| `packages/happy-app-logs` | Log viewer |

## Getting Started

### Prerequisites

- **Node.js** 22+
- **Yarn** 1.x (classic)
- **iOS**: Xcode (for simulator)
- **Android**: Android Studio (for emulator)

### Setup

```bash
# Clone the repo
git clone https://github.com/slopus/happy.git
cd happy

# Install dependencies
yarn install

# Run the web app
yarn web

# Run on iOS simulator
cd packages/happy-app && yarn ios

# Run on Android emulator
cd packages/happy-app && yarn android
```

### Useful Commands

```bash
# Type checking (run after every change)
cd packages/happy-app && yarn typecheck

# Run tests
cd packages/happy-app && yarn test

# Run CLI locally
yarn cli
```

## Making Changes

### 1. Find an Issue

- Look for issues labeled [`good first issue`](https://github.com/slopus/happy/labels/good%20first%20issue) or [`help wanted`](https://github.com/slopus/happy/labels/help%20wanted)
- Comment on the issue to let others know you're working on it

### 2. Create a Branch

```bash
git checkout -b fix/123-short-description  # for bug fixes
git checkout -b feat/456-short-description  # for features
```

### 3. Code Style

- **TypeScript** with strict mode
- **4 spaces** for indentation
- Use `yarn typecheck` to verify type safety
- Platform-specific code goes in `.web.tsx` / `.ios.tsx` / `.android.tsx` files
- Use the `t()` function for all user-visible strings (i18n)
- Styles go at the bottom of the file using `StyleSheet.create` from `react-native-unistyles`

### 4. Internationalization

All user-facing strings must use the translation function:

```typescript
import { t } from '@/text';
t('common.cancel')  // not "Cancel"
```

When adding new strings, add them to **all** language files in `sources/text/translations/`.

### 5. Submit a PR

- Keep PRs focused — one issue per PR
- Write a clear description of what changed and why
- Include steps to test your changes
- Reference the related issue (e.g., "Fixes #123")

## Platform Notes

Happy targets **iOS, Android, and Web**. Web is a secondary platform. When making changes:

- Test on at least one native platform (iOS or Android) if possible
- Use platform-specific files (`.web.tsx`) when native and web behavior must differ
- React Native's `FlatList` with `inverted={true}` uses `scaleY(-1)` on web — be aware of this for scroll-related work

## Questions?

If you're unsure about anything, feel free to open an issue or comment on an existing one. The community is friendly and happy to help!
