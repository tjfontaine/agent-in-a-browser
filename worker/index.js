// Worker entry point for serving static assets
// The ASSETS binding handles all static file serving automatically

export default {
    async fetch(request, env, ctx) {
        // Let the ASSETS binding handle all requests
        return env.ASSETS.fetch(request);
    },
};
