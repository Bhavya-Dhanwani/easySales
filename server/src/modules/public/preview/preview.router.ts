// Importing modules
import express, { Request, Response } from "express";
import { findPreview } from "../../../shared/prototypes/prototype.service.js";

const router = express.Router();

/*
    The page is served as an inert document: CSP "sandbox" gives it an opaque origin,
    so even on the app's own host it cannot read cookies, storage or call the API;
    scripts, forms, frames and every remote resource are blocked.
*/
const PREVIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors *";

/*
    @route GET /api/preview/:token
    @desc Public, expiring prototype preview (the token is the only credential)
*/
router.get("/:token", async (req: Request, res: Response) => {
    res.set({
        "Content-Security-Policy": PREVIEW_CSP,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "Cross-Origin-Resource-Policy": "same-site",
    });
    res.removeHeader("X-Frame-Options");
    const html = await findPreview(String(req.params.token));
    if (!html) return res.status(410).type("text/plain").send("This preview has expired or was revoked.");
    return res.status(200).type("text/html; charset=utf-8").send(html);
});

export default router;
