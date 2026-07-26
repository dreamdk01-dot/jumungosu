// pages/api/auth/[...nextauth].js
//
// "주문의 고수" 소셜 로그인 (카카오 / 네이버 / 구글) — NextAuth.js 설정
//
// ⚠️ DB 연동 전 임시 구조입니다.
// session.strategy를 'jwt'로 설정했기 때문에 NextAuth의 Adapter(DB 연결)
// 없이도 로그인 → 세션 유지가 정상적으로 동작합니다. 로그인 정보는
// 서버가 서명한 JWT 쿠키에만 저장되고, 별도의 회원 테이블에는 아직
// 기록되지 않습니다. DB를 연동하면 아래 "DB 연동 시" 표시된 부분만
// 고치면 됩니다 (구조 자체를 바꿀 필요는 없습니다).

import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import KakaoProvider from "next-auth/providers/kakao";

export const authOptions = {
  providers: [
    // ------------------------------------------------------------
    // 구글 로그인 (NextAuth 공식 내장 프로바이더)
    // ------------------------------------------------------------
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),

    // ------------------------------------------------------------
    // 카카오 로그인 (NextAuth 공식 내장 프로바이더)
    // ------------------------------------------------------------
    KakaoProvider({
      clientId: process.env.KAKAO_CLIENT_ID,
      clientSecret: process.env.KAKAO_CLIENT_SECRET,
    }),

    // ------------------------------------------------------------
    // 네이버 로그인 (NextAuth에 공식 내장 프로바이더가 없어 커스텀 OAuth로 직접 정의)
    // ------------------------------------------------------------
    {
      id: "naver",
      name: "Naver",
      type: "oauth",
      authorization: {
        url: "https://nid.naver.com/oauth2.0/authorize",
        params: { response_type: "code" },
      },
      token: "https://nid.naver.com/oauth2.0/token",
      userinfo: "https://openapi.naver.com/v1/nid/me",
      clientId: process.env.NAVER_CLIENT_ID,
      clientSecret: process.env.NAVER_CLIENT_SECRET,
      checks: ["state"],
      profile(profile) {
        // 네이버 API는 실제 사용자 정보를 profile.response 아래에 담아 내려줍니다.
        const naverAccount = profile.response;
        return {
          id: naverAccount.id,
          name: naverAccount.nickname || naverAccount.name,
          email: naverAccount.email,
          image: naverAccount.profile_image,
        };
      },
    },
  ],

  // DB 없이 로그인 테스트가 가능한 핵심 설정: 세션을 DB가 아닌 JWT(서명된 쿠키)로 관리합니다.
  session: {
    strategy: "jwt",
  },

  secret: process.env.NEXTAUTH_SECRET,

  callbacks: {
    // 최초 로그인 성공 시(user, account, profile 존재) 토큰에 필요한 정보를 실어둡니다.
    // 이후 요청부터는 user 없이 token만 넘어오므로, 여기서 한 번 심어둔 값이 계속 유지됩니다.
    async jwt({ token, user, account, profile }) {
      if (account && user) {
        token.provider = account.provider; // 'google' | 'kakao' | 'naver'
        token.providerAccountId = account.providerAccountId;

        // ---------------------------------------------------------
        // DB 연동 시: 여기서 실제 회원 테이블을 조회하고,
        // 없으면 신규 생성(기본 role: 'USER', level: 0)한 뒤
        // 그 결과(닉네임/연락처/관심지역/레벨/권한)를 token에 넣어주세요.
        // 예)
        //   const dbUser = await findOrCreateUser({
        //     provider: account.provider,
        //     providerAccountId: account.providerAccountId,
        //     email: user.email,
        //     nickname: user.name,
        //   });
        //   token.id = dbUser.id;
        //   token.role = dbUser.role;
        //   token.level = dbUser.level;
        //   token.phone = dbUser.phone;
        //   token.region = dbUser.region;
        // ---------------------------------------------------------

        // DB 연동 전 임시 기본값: 모든 신규/기존 소셜 로그인은 일반 회원(USER)으로 처리
        token.id = token.id || account.providerAccountId;
        token.role = token.role || "USER";
        token.level = token.level ?? 0;
        token.nickname = user.name;
        token.email = user.email;
      }
      return token;
    },

    // 클라이언트(useSession/getSession)에서 꺼내 쓸 session.user 형태를 구성합니다.
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.provider = token.provider;
      session.user.role = token.role;   // 'USER' (관리자 권한은 별도 화면/비밀번호로만 부여)
      session.user.level = token.level;
      session.user.nickname = token.nickname;
      return session;
    },
  },

  // 커스텀 로그인 화면을 쓰고 싶다면 아래 주석을 해제하고 경로를 지정하세요.
  // pages: {
  //   signIn: '/login',
  // },
};

export default NextAuth(authOptions);

// ---------------------------------------------------------------------------
// App Router(app/ 디렉토리)를 쓰는 프로젝트라면 이 파일 대신 아래 경로/형태로 만드세요:
//   app/api/auth/[...nextauth]/route.js
//
//   import NextAuth from "next-auth";
//   import { authOptions } from "./authOptions"; // 위 authOptions를 별도 파일로 분리
//   const handler = NextAuth(authOptions);
//   export { handler as GET, handler as POST };
// ---------------------------------------------------------------------------
