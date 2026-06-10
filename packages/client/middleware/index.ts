import { defineMiddleware, sequence } from 'astro/middleware';
import { i18nMiddleware, getLocale } from 'astro-i18n-aut';
import { defaultLocale, changeLanguage, type Locale } from '@kaetram/common/i18n';

let language = defineMiddleware(async ({ url }, next) => {
        let lang = getLocale(url) as Locale;
        await changeLanguage(lang || defaultLocale);

        return await next();
    }),
    // CSP frame-ancestors — allow FuzzyNuts Arcade lobby to embed this game in an iframe
    securityHeaders = defineMiddleware(async (_context, next) => {
        let response = await next();

        response.headers.set(
            'Content-Security-Policy',
            "frame-ancestors 'self' https://www.fuzzynuts.xyz http://localhost:3000"
        );
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

        return response;
    });

export let onRequest = sequence(securityHeaders, i18nMiddleware, language);
