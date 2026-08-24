import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RegisterServiceWorker } from "./register-sw";
import { ProfileMenu } from "@/components/ProfileMenu";
import { SikkaLogo } from "@/components/SikkaLogo";
import { IngestionHealthBanner } from "@/components/IngestionHealthBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sikka",
  description: "Sikka",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Sikka",
  },
  icons: {
    // The SVG first so a browser that supports it gets the sharp one at any
    // size; the PNGs remain for those that don't.
    icon: [
      { url: "/icons/sikka-icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS ignores SVG here and composites any transparency onto black, so this
    // one file is deliberately opaque - see public/icons/apple-touch-icon.png.
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  // Matches the app plane, so the iOS/Android chrome blends into the page
  // instead of framing it in black.
  themeColor: "#fbf9f6",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <RegisterServiceWorker />
        <IngestionHealthBanner />
        {/* The profile button replaces the old tab bar: every other screen is
            reached from the menu it opens, leaving the dashboard as the
            default view. It lives in the layout so it is present on those
            screens too, not just here. */}
        <header className="flex items-center justify-between px-4 pt-4">
          <SikkaLogo />
          <ProfileMenu />
        </header>
        {children}
      </body>
    </html>
  );
}
