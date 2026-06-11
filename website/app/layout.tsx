import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://davidecarvalho.github.io/nestjs-durable'),
  title: {
    default: 'nestjs-durable',
    template: '%s — nestjs-durable',
  },
  description:
    'Durable workflows for NestJS — write a workflow as plain code; every step is checkpointed, so it survives crashes and deploys. Steps can run across apps and languages (incl. Python), with a built-in control plane.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
