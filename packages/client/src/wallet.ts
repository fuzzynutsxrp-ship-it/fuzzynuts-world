/**
 * Multi-wallet integration for Fuzzynuts World MMORPG.
 * Ported from the arcade's FuzzyWallet (website/arcade/wallet.js).
 * Supports: Xaman (QR/mobile), GemWallet (extension), Crossmark (extension).
 *
 * Joey was removed — raw address input has no proof of ownership,
 * allowing anyone to impersonate any wallet. Only wallets with
 * cryptographic signing flows are supported for game auth.
 *
 * This module provides a unified connect() interface that returns a wallet address
 * regardless of which wallet the player uses. The game's login system uses this
 * address as the authentication credential.
 */

// Xaman API key for Fuzzynuts — registered at apps.xaman.dev
const XAMAN_API_KEY = 'f4f734d6-c1d6-484a-84c1-70322602a7f5';

export type WalletType = 'xaman' | 'gemwallet' | 'crossmark';

export interface WalletResult {
    address: string;
    walletType: WalletType;
    displayName: string;
}

/**
 * Truncates an XRPL address for display: rABC...1234
 */
function truncateAddress(addr: string): string {
    if (!addr || addr.length < 10) return addr;
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

/**
 * Validates XRPL address format.
 */
function isValidAddress(address: string): boolean {
    return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
}

/**
 * Attempts to connect via Xaman (mobile QR code flow).
 */
async function connectXaman(): Promise<WalletResult | null> {
    try {
        // Dynamically load Xaman SDK
        if (!(window as any).XummSdk && !(window as any).Xumm) {
            let script = document.createElement('script');
            script.src = 'https://xumm.app/assets/cdn/xumm.min.js';
            document.head.append(script);
            await new Promise<void>((resolve, reject) => {
                script.onload = () => resolve();
                script.onerror = () => reject(new Error('Failed to load Xaman SDK'));
                setTimeout(() => reject(new Error('Xaman SDK load timeout')), 10_000);
            });
        }

        let XummClass = (window as any).Xumm || (window as any).XummSdk;
        if (!XummClass) return null;

        let xumm = new XummClass(XAMAN_API_KEY);
        await xumm.authorize();

        let account = await xumm.user?.account;

        if (account && isValidAddress(account)) {
            return {
                address: account,
                walletType: 'xaman',
                displayName: truncateAddress(account)
            };
        }

        return null;
    } catch (error) {
        console.warn('[Wallet] Xaman connection failed:', error);
        return null;
    }
}

/**
 * Attempts to connect via GemWallet (browser extension).
 */
async function connectGemWallet(): Promise<WalletResult | null> {
    try {
        let api = (window as any).GemWalletApi;
        if (!api) {
            console.warn('[Wallet] GemWallet extension not detected');
            return null;
        }

        let response = await api.isInstalled();
        if (!response?.result?.isInstalled) return null;

        let addressResponse = await api.getAddress();
        let address = addressResponse?.result?.address;

        if (address && isValidAddress(address)) {
            return {
                address,
                walletType: 'gemwallet',
                displayName: truncateAddress(address)
            };
        }

        return null;
    } catch (error) {
        console.warn('[Wallet] GemWallet connection failed:', error);
        return null;
    }
}

/**
 * Attempts to connect via Crossmark (browser extension).
 */
async function connectCrossmark(): Promise<WalletResult | null> {
    try {
        let xrpl = (window as any).xrpl;
        if (!xrpl?.crossmark) {
            console.warn('[Wallet] Crossmark extension not detected');
            return null;
        }

        let { response } = await xrpl.crossmark.signInAndWait();

        if (response?.data?.address && isValidAddress(response.data.address)) {
            return {
                address: response.data.address,
                walletType: 'crossmark',
                displayName: truncateAddress(response.data.address)
            };
        }

        return null;
    } catch (error) {
        console.warn('[Wallet] Crossmark connection failed:', error);
        return null;
    }
}


// ── Persistence ──

function saveWalletState(result: WalletResult): void {
    try {
        localStorage.setItem(
            'fuzzy_wallet_game',
            JSON.stringify({
                address: result.address,
                walletType: result.walletType
            })
        );
    } catch {
        /* ignore */
    }
}

function loadWalletState(): { address: string; walletType: WalletType } | null {
    try {
        let saved = JSON.parse(localStorage.getItem('fuzzy_wallet_game') || '{}');
        if (saved.address && saved.walletType) return saved;
    } catch {
        /* ignore */
    }
    return null;
}

export function clearWalletState(): void {
    try {
        localStorage.removeItem('fuzzy_wallet_game');
    } catch {
        /* ignore */
    }
}

// ── Public API ──

export default {
    connectXaman,
    connectGemWallet,
    connectCrossmark,
    saveWalletState,
    loadWalletState,
    clearWalletState,
    truncateAddress,
    isValidAddress
};
