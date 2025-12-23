// Worker entry point for serving static assets
// The ASSETS binding handles all static file serving automatically
// Adds COOP/COEP headers for SharedArrayBuffer support

export default {
    async fetch(request, env, ctx) {
        // Get the response from the ASSETS binding
        const response = await env.ASSETS.fetch(request);

        // Create new headers, copying all originals
        const headers = new Headers(response.headers);

        // Add cross-origin isolation headers for SharedArrayBuffer support
        // Required for the OPFS async helper worker to use Atomics.wait()
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

        // Return new response with modified headers
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headers
        });
    },
};
