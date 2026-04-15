import { test, expect } from '@playwright/test';
import * as tweetnacl from 'tweetnacl';

const SERVER_URL = 'http://localhost:3005';
const APP_URL = 'http://localhost:8081';

// ─── Auth helpers ──────────────────────────────────────────────────────────

function toBase64(buf: Uint8Array): string {
    return Buffer.from(buf).toString('base64');
}

async function createTestAccount(): Promise<{ token: string; secret: string }> {
    const seed = tweetnacl.randomBytes(32);
    const keypair = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

    const response = await fetch(`${SERVER_URL}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: toBase64(keypair.publicKey),
            challenge: toBase64(challenge),
            signature: toBase64(signature),
        }),
    });

    if (!response.ok) {
        throw new Error(`Auth failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { token: string };
    return { token: data.token, secret: Buffer.from(seed).toString('base64url') };
}

function authenticatedUrl(token: string, secret: string): string {
    return `${APP_URL}/?dev_token=${encodeURIComponent(token)}&dev_secret=${encodeURIComponent(secret)}`;
}

async function createSession(token: string): Promise<string> {
    const response = await fetch(`${SERVER_URL}/v1/sessions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
            tag: `e2e-star-test-${Date.now()}`,
            // Plain text metadata — will fail to decrypt in the app (shows as "unknown"),
            // but the session still appears in the inactive session list.
            metadata: 'e2e-placeholder',
        }),
    });

    if (!response.ok) {
        throw new Error(`Session creation failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { session: { id: string } };
    return data.session.id;
}

// ─── Shared state ─────────────────────────────────────────────────────────

let testToken: string;
let testSecret: string;
let sessionId: string;

// ─── Tests ────────────────────────────────────────────────────────────────

test.describe('Session Favorites (Star/Unstar)', () => {

    test.beforeAll(async () => {
        const creds = await createTestAccount();
        testToken = creds.token;
        testSecret = creds.secret;
        sessionId = await createSession(testToken);
    });

    test('session appears in the list after creation', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        const item = page.getByTestId(`session-item-${sessionId}`);
        await expect(item).toBeVisible({ timeout: 20_000 });
    });

    test('right-click opens context menu with Star action', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        const item = page.getByTestId(`session-item-${sessionId}`);
        await expect(item).toBeVisible({ timeout: 20_000 });

        await item.click({ button: 'right' });

        const starAction = page.getByTestId('session-action-star');
        await expect(starAction).toBeVisible({ timeout: 5_000 });
    });

    test('starring a session shows gold star badge on avatar', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        const item = page.getByTestId(`session-item-${sessionId}`);
        await expect(item).toBeVisible({ timeout: 20_000 });

        // Open context menu and star
        await item.click({ button: 'right' });
        await page.getByTestId('session-action-star').click();

        // Star badge should appear
        const badge = page.getByTestId(`session-star-badge-${sessionId}`);
        await expect(badge).toBeVisible({ timeout: 5_000 });
    });

    test('starred session moves to Starred section header', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        const item = page.getByTestId(`session-item-${sessionId}`);
        await expect(item).toBeVisible({ timeout: 20_000 });

        // Star the session (may already be starred from previous test, but star again in case)
        await item.click({ button: 'right' });
        const starAction = page.getByTestId('session-action-star');
        const label = await starAction.textContent();

        // If already starred, unstar first, then re-star to ensure we end up starred
        if (label?.includes('Unstar')) {
            await starAction.click();
            await expect(page.getByTestId(`session-star-badge-${sessionId}`)).not.toBeVisible({ timeout: 5_000 });
            await item.click({ button: 'right' });
            await page.getByTestId('session-action-star').click();
        } else {
            await starAction.click();
        }

        // "Starred" section header should appear in the list
        const starredHeader = page.getByText('Starred');
        await expect(starredHeader).toBeVisible({ timeout: 5_000 });
    });

    test('unstarring removes star badge', async ({ page }) => {
        await page.goto(authenticatedUrl(testToken, testSecret));
        const item = page.getByTestId(`session-item-${sessionId}`);
        await expect(item).toBeVisible({ timeout: 20_000 });

        // Ensure session is starred first
        await item.click({ button: 'right' });
        const starAction = page.getByTestId('session-action-star');
        const label = await starAction.textContent();

        if (label?.includes('Star') && !label.includes('Unstar')) {
            await starAction.click();
            // Now it's starred — re-open menu
            await item.click({ button: 'right' });
        }

        // Now unstar
        await page.getByTestId('session-action-star').click();

        // Badge should disappear
        await expect(page.getByTestId(`session-star-badge-${sessionId}`)).not.toBeVisible({ timeout: 5_000 });
    });

});
