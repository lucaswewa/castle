import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const spaceGrotesk = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Castle - Play chess together",
    description: "A fast, focused place to play live chess with friends.",
    openGraph: {
      title: "Castle - Play chess together",
      description: "Classic chess. Zero clutter.",
      images: [{ url: image, width: 1732, height: 909, alt: "Castle - live chess with friends" }],
    },
    twitter: { card: "summary_large_image", title: "Castle - Play chess together", description: "Classic chess. Zero clutter.", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${dmSans.variable} ${spaceGrotesk.variable} antialiased`}>{children}</body></html>;
}
