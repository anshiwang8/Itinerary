import type { Metadata, Viewport } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

export const metadata: Metadata = {
  title: "Itinerary: time to leave.",
  description: "Plan your day, weather included.",
};

// `viewportFit: "cover"` is required for `env(safe-area-inset-bottom)` to
// resolve to anything other than 0 on iOS — without it the mobile bottom
// sheet's peek content would sit flush under a notched device's home
// indicator (see MobileItinerarySheet.tsx's readSafeAreaBottomPx and the
// .msheet padding-bottom in globals.css). No other effect: on every other
// device this is a no-op.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
