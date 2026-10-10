// Importing modules
import BadRequest from "../errors/BadRequest.error.js";

export interface PricedItem {
    name: string;
    quantity: number;
    unitPriceMinor: number;
    priceMinor: number;
}

export type Selection = string | { name: string; quantity: number };

const safe = (n: number, what: string) => {
    if (!Number.isSafeInteger(n)) throw new BadRequest(`${what} exceeds the safe range`);
    return n;
};

// rounds value * bps / 10000 half-up, in integers
const bpsOf = (value: number, bps: number) => Math.floor((value * bps + 5000) / 10000);

/*
    Deterministic pricing from the approved price book (the configured services):
    integer minor units only, discount on the subtotal, tax on the discounted amount,
    each rounded half-up once. No floating point money leaves this function.
*/
export function priceProposal(
    services: { name: string; basePriceMinor: number }[],
    selected: Selection[],
    discountPercent: number,
    taxBasisPoints = 0,
) {
    if (!selected.length) throw new BadRequest("Select at least one service");
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        throw new BadRequest("Discount must be between 0 and 100");
    }
    if (!Number.isSafeInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 10000) throw new BadRequest("Invalid tax rate");

    const seen = new Set<string>();
    const items: PricedItem[] = selected.map((sel) => {
        const { name, quantity } = typeof sel === "string" ? { name: sel, quantity: 1 } : sel;
        if (seen.has(name)) throw new BadRequest(`Service listed twice: ${name}`);
        seen.add(name);
        const service = services.find((s) => s.name === name);
        if (!service) throw new BadRequest(`Unknown service: ${name}`);
        if (!Number.isSafeInteger(service.basePriceMinor) || service.basePriceMinor < 0) {
            throw new BadRequest(`Service ${name} has an invalid price`);
        }
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new BadRequest(`Invalid quantity for ${name}`);
        return { name: service.name, quantity, unitPriceMinor: service.basePriceMinor, priceMinor: safe(service.basePriceMinor * quantity, "Line total") };
    });

    const subtotalMinor = safe(items.reduce((sum, i) => sum + i.priceMinor, 0), "Subtotal");
    // discount in basis points keeps the arithmetic in integers
    const discountBps = Math.round(discountPercent * 100);
    const discountMinor = safe(bpsOf(subtotalMinor, discountBps), "Discount");
    const netMinor = subtotalMinor - discountMinor;
    const taxMinor = safe(bpsOf(netMinor, taxBasisPoints), "Tax");
    const totalMinor = safe(netMinor + taxMinor, "Total");

    return { items, subtotalMinor, discountPercent: discountBps / 100, discountMinor, taxBasisPoints, taxMinor, totalMinor };
}

// splits the total by percentage; the last instalment takes the rounding remainder so the parts always add up
export function splitPayments(totalMinor: number, schedule: { label: string; percent: number }[]) {
    if (schedule.reduce((a, s) => a + s.percent, 0) !== 100) throw new BadRequest("Payment schedule must add up to 100%");
    let left = totalMinor;
    return schedule.map((s, i) => {
        const amountMinor = i === schedule.length - 1 ? left : Math.floor((totalMinor * s.percent) / 100);
        left -= amountMinor;
        return { label: s.label, percent: s.percent, amountMinor };
    });
}

// formats integer minor units for display, e.g. 2500000 INR -> ₹25,000.00
export function formatMoney(minor: number, currency: string) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}
