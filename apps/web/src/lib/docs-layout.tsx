import Image from "next/image";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

function DocsBrand() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold">
      <Image
        src="/brand/odyshell-on-light.svg"
        alt=""
        width={18}
        height={18}
        className="dark:hidden"
      />
      <Image
        src="/brand/odyshell-on-dark.svg"
        alt=""
        width={18}
        height={18}
        className="hidden dark:block"
      />
      Odyshell
    </span>
  );
}

export function docsLayoutOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <DocsBrand />,
      url: "/",
      transparentMode: "none",
    },
    links: [
      {
        text: "Dashboard",
        url: "/dashboard",
      },
      {
        text: "GitHub",
        url: "https://github.com/kapeka0/Odyshell",
        external: true,
      },
    ],
    themeSwitch: {
      enabled: false,
    },
  };
}
