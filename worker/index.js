// Worker entry point for serving static assets
// The ASSETS binding handles all static file serving automatically
// Adds COOP/COEP headers for SharedArrayBuffer support

export default {
    async fetch(request, env, ctx) {
        // Get the response from the ASSETS binding
        const response = await env.ASSETS.fetch(request);

        // Clone the response so we can modify headers
        const newResponse = new Response(response.body, response);

        // Add cross-origin isolation headers for SharedArrayBuffer support
        // Required for the OPFS async helper worker to use Atomics.wait()
        newResponse.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        newResponse.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

        return newResponse;
    },
};
