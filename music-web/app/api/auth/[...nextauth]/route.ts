import NextAuth from "next-auth";
import DiscordProvider from "next-auth/providers/discord";

const handler = NextAuth({
  providers: [
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
      // Discord answers the login callback with an `iss` parameter (RFC 9207). openid-client checks it
      // against the provider issuer and fails with "issuer must be configured on the issuer" when it is unset.
      issuer: 'https://discord.com',
      authorization: { params: { scope: 'identify guilds' } },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }: any) {
      if (account) {
        token.accessToken = account.access_token;
      }
      // ดึง Display Name และ Username ของจริงจาก Discord มาเก็บไว้
      if (profile) {
        token.username = profile.username;
        token.displayName = profile.global_name || profile.username;
      }
      return token;
    },
    async session({ session, token }: any) {
      session.accessToken = token.accessToken;
      // ส่งค่าไปให้หน้าเว็บใช้งาน
      (session.user as any).id = token.sub;
      (session.user as any).username = token.username;
      (session.user as any).displayName = token.displayName;
      return session;
    },
  },
});

export { handler as GET, handler as POST };