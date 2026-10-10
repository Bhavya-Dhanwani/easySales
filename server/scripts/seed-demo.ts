/*
    Development-only demo data: a verified account with a filled-in business profile
    and a few sample leads. Run with `npm run seed:demo` against a local database.
    Never run against production.
*/
import mongoose from "mongoose";
import connectDB from "../src/shared/config/db.config.js";
import env from "../src/shared/config/env.config.js";
import User from "../src/shared/models/user.model.js";
import BusinessProfile from "../src/shared/models/businessProfile.model.js";
import Lead from "../src/shared/models/lead.model.js";
import Membership from "../src/shared/models/membership.model.js";
import { createOrganizationForUser } from "../src/shared/tenancy/organization.service.js";

export const DEMO_ACCOUNT = {
    name: "Demo Owner",
    email: "demo@easysales.test",
    password: "demo-local-only-8c1f",
};

async function main() {
    if (env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
    await connectDB();

    let user = await User.findOne({ email: DEMO_ACCOUNT.email });
    if (!user) user = await User.create({ ...DEMO_ACCOUNT, providers: ["local"], isVerified: true });
    else await User.updateOne({ _id: user._id }, { isVerified: true });

    let membership = await Membership.findOne({ userId: user._id, status: "active" }).setOptions({ crossTenant: true });
    if (!membership) {
        await createOrganizationForUser(user, "Pixel Forge Studio");
        membership = await Membership.findOne({ userId: user._id, status: "active" }).setOptions({ crossTenant: true });
    }
    const organizationId = membership!.organizationId;

    await BusinessProfile.updateOne({ organizationId }, {
        businessName: "Pixel Forge Studio",
        businessType: "Web & product studio",
        description: "We design and build fast marketing websites, booking systems and internal tools for clinics, schools and local service businesses in India.",
        website: "https://example.com",
        brandVoice: "warm, concise, practical",
        services: [
            { name: "Marketing website", description: "Fast, mobile-first website with CMS", basePriceMinor: 60_000_00, deliveryDaysMin: 14, deliveryDaysMax: 28 },
            { name: "Online booking system", description: "Appointment booking with reminders", basePriceMinor: 90_000_00, deliveryDaysMin: 21, deliveryDaysMax: 35 },
            { name: "SEO starter", description: "Technical SEO and local listings", basePriceMinor: 25_000_00 },
        ],
        idealCustomerProfile: {
            industries: ["Healthcare", "Education", "Hospitality"], companySizes: ["11-50", "51-200"], regions: ["India"],
            requiredSignals: ["Outdated or slow website", "Phone-only bookings"], disqualifiers: ["Government body", "Direct competitor"],
        },
        approvedClaims: ["We have shipped 40+ websites for local businesses", "Typical sites load in under 2 seconds on mobile"],
        prohibitedClaims: ["guaranteed", "#1", "cheapest"],
    });

    const leads = [
        { company: { name: "Sunrise Dental Care", website: "https://example.org", domain: "example.org", industry: "Healthcare", country: "India" }, contact: { name: "Priya Sharma", title: "Practice Manager", email: "priya@sunrise-dental.test" } },
        { company: { name: "Bright Minds Academy", website: "https://example.net", domain: "example.net", industry: "Education", country: "India" }, contact: { name: "Rahul Verma", title: "Director", email: "rahul@brightminds.test" } },
        { company: { name: "Lakeview Homestay", industry: "Hospitality", country: "India" }, contact: { name: "Anita Rao", title: "Owner", email: "anita@lakeview.test" } },
    ];
    for (const l of leads) {
        await Lead.updateOne(
            { organizationId, "contact.email": l.contact.email },
            { $setOnInsert: { organizationId, ...l, consent: { basis: "legitimate_interest", source: "demo seed", recordedAt: new Date() }, source: { provider: "seed" } } },
            { upsert: true },
        );
    }

    console.log(`Seeded demo workspace. Log in as ${DEMO_ACCOUNT.email} (password in scripts/seed-demo.ts).`);
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
});
