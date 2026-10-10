// Importing modules
import BadRequest from "../errors/BadRequest.error.js";

export interface PricedItem {
    name: string;
    priceMinor: number;
}

/*
    Deterministic pricing: line items come from the configured service catalogue,
    the discount is applied once to the subtotal and rounded half-up to whole minor units.
    No floating point money leaves this function.
*/
export function priceProposal(
    services: { name: string; basePriceMinor: number }[],
    selected: string[],
    discountPercent: number,
) {
    if (!selected.length) throw new BadRequest("Select at least one service");
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        throw new BadRequest("Discount must be between 0 and 100");
    }

    const items: PricedItem[] = selected.map((name) => {
        const service = services.find((s) => s.name === name);
        if (!service) throw new BadRequest(`Unknown service: ${name}`);
        if (!Number.isSafeInteger(service.basePriceMinor) || service.basePriceMinor < 0) {
            throw new BadRequest(`Service ${name} has an invalid price`);
        }
        return { name: service.name, priceMinor: service.basePriceMinor };
    });

    const subtotalMinor = items.reduce((sum, i) => sum + i.priceMinor, 0);
    // discount in basis points keeps the arithmetic in integers
    const discountBps = Math.round(discountPercent * 100);
    const discountMinor = Math.floor((subtotalMinor * discountBps + 5000) / 10000);
    const totalMinor = subtotalMinor - discountMinor;

    return { items, subtotalMinor, discountPercent: discountBps / 100, discountMinor, totalMinor };
}

// formats integer minor units for display, e.g. 2500000 INR -> ₹25,000.00
export function formatMoney(minor: number, currency: string) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}
