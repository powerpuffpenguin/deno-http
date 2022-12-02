// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "../deps/std/testing/asserts.ts";
import { Jar } from "./cookiejar.ts";
import { Cookie, getCookies, getSetCookies } from "./cookie.ts";
import { toIMF } from "../deps/std/datetime/mod.ts";

const tNow = new Date(2013, 1, 1, 12, 0, 0, 0);
// expiresIn creates an expires attribute delta seconds from tNow.
function expiresIn(delta: number): string {
  const t = new Date(tNow.getTime() + delta * 1000);
  return "expires=" + toIMF(t);
}
interface IEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  sameSite: string;
  secure?: boolean;
  httpOnly?: boolean;
  persistent?: boolean;
  hostOnly?: boolean;
  expires: number;
  creation: number;
  lastAccess: number;

  // seqNum is a sequence number so that Cookies returns cookies in a
  // deterministic order, even for cookies that have equal Path length and
  // equal Creation time. This simplifies testing.
  seqNum: bigint;

  // id returns the domain;path;name triple of e as an id.
  id(): string;
  // shouldSend determines whether e's cookie qualifies to be included in a
  // request to host/path. It is the caller's responsibility to check if the
  // cookie is expired.
  shouldSend(https: boolean, host: string, path: string): boolean;

  // domainMatch implements "domain-match" of RFC 6265 section 5.1.3.
  domainMatch(host: string): boolean;
  pathMatch(requestPath: string): boolean;
}
interface IJar {
  entries_: Map<string, Map<string, IEntry>>;
  _setCookies(u: URL, cookies: Array<Cookie>, now: number): void;
  _cookies(u: URL, now: number): Array<Cookie> | undefined;
}
class jarTest {
  // description = ""; // The description of what this test is supposed to test
  // fromURL = ""; // The full URL of the request from which Set-Cookie headers where received
  // setCookies: Array<string> = []; // All the cookies received from fromURL
  // content = ""; // The whole (non-expired) content of the jar
  // queries: Array<query> = [];
  constructor(
    public readonly description: string,
    public readonly fromURL: string,
    public readonly setCookies: Array<string>,
    public readonly content: string,
    public readonly queries: Array<query>,
  ) {
  }
  // run runs the jarTest.
  run(ijar: Jar) {
    const jar = (ijar as any) as IJar;
    let now = tNow.getTime();

    // Populate jar with cookies.
    const setCookies = new Array<Cookie>(this.setCookies.length);
    for (let i = 0; i < this.setCookies.length; i++) {
      const cs = this.setCookies[i];

      const cookies = getSetCookies(
        new Headers({
          "Set-Cookie": cs,
        }),
      );
      console.log("set-cookie", cs, cookies.length);
      if (cookies.length != 1) {
        throw new Error(`Wrong cookie line ${cs}: ${cookies}`);
      }
      setCookies[i] = cookies[0];
    }
    jar._setCookies(new URL(this.fromURL), setCookies, now);
    now += 1001;

    // Serialize non-expired entries in the form "name1=val1 name2=val2".
    const cs = new Array<string>();
    for (const submap of jar.entries_.values()) {
      for (const cookie of submap.values()) {
        if (!(cookie.expires > now)) {
          continue;
        }
        cs.push(`${cookie.name}=${cookie.value}`);
      }
    }
    cs.sort();
    const got = cs.join(" ");

    // Make sure jar content matches our expectations.
    assertEquals(
      got,
      this.content,
      `test ${this.description} Content
got ${got}
want ${this.content}`,
    );

    // Test different calls to Cookies.
    for (let i = 0; i < this.queries.length; i++) {
      const query = this.queries[i];
      now += 1001;
      const s = new Array<string>();
      for (const c of jar._cookies(new URL(query.toURL), now) ?? []) {
        s.push(`${c.name}=${c.value}`);
      }
      const got = s.join(" ");
      assertEquals(
        got,
        query.want,
        `Test ${this.description} #${i}
got ${got}
want ${query.want}`,
      );
    }
  }
}
// query contains one test of the cookies returned from Jar.Cookies.
interface query {
  toURL: string; // the URL in the Cookies call
  want: string; // the expected list of cookies (order matters)
}
function newTestJar(): Jar {
  return new Jar({
    publicSuffixList: {
      publicSuffix(d) {
        if (d == "co.uk" || d.endsWith(".co.uk")) {
          return "co.uk";
        }
        if (d == "www.buggy.psl") {
          return "xy";
        }
        if (d == "www2.buggy.psl") {
          return "com";
        }
        return d.substring(d.lastIndexOf(".") + 1);
      },
    },
  });
}
function make(toURL: string, want: string) {
  return {
    toURL: toURL,
    want: want,
  };
}
Deno.test("Basics", () => {
  const tests: Array<jarTest> = [
    new jarTest(
      "Set initial cookies.",
      "http://www.host.test",
      ["a=1", "b=2; secure", "c=3; httponly", "d=4; secure; httponly"],
      "a=1 b=2 c=3 d=4",
      [
        make("http://www.host.test", "a=1 c=3"),
        make("https://www.host.test", "a=1 b=2 c=3 d=4"),
      ],
    ),
    new jarTest(
      "Secure cookies are not returned to http.",
      "http://www.host.test/",
      ["A=a; secure"],
      "A=a",
      [
        make("http://www.host.test", ""),
        make("http://www.host.test/", ""),
        make("http://www.host.test/some/path", ""),
        make("https://www.host.test", "A=a"),
        make("https://www.host.test/", "A=a"),
        make("https://www.host.test/some/path", "A=a"),
      ],
    ),
    new jarTest(
      "Explicit path.",
      "http://www.host.test/",
      ["A=a; path=/some/path"],
      "A=a",
      [
        make("http://www.host.test", ""),
        make("http://www.host.test/", ""),
        make("http://www.host.test/some", ""),
        make("http://www.host.test/some/", ""),
        make("http://www.host.test/some/path", "A=a"),
        make("http://www.host.test/some/paths", ""),
        make("http://www.host.test/some/path/foo", "A=a"),
        make("http://www.host.test/some/path/foo/", "A=a"),
      ],
    ),
    new jarTest(
      "Implicit path #1: path is a directory.",
      "http://www.host.test/some/path/",
      ["A=a"],
      "A=a",
      [
        make("http://www.host.test", ""),
        make("http://www.host.test/", ""),
        make("http://www.host.test/some", ""),
        make("http://www.host.test/some/", ""),
        make("http://www.host.test/some/path", "A=a"),
        make("http://www.host.test/some/paths", ""),
        make("http://www.host.test/some/path/foo", "A=a"),
        make("http://www.host.test/some/path/foo/", "A=a"),
      ],
    ),
    new jarTest(
      "Implicit path #2: path is not a directory.",
      "http://www.host.test/some/path/index.html",
      ["A=a"],
      "A=a",
      [
        make("http://www.host.test", ""),
        make("http://www.host.test/", ""),
        make("http://www.host.test/some", ""),
        make("http://www.host.test/some/", ""),
        make("http://www.host.test/some/path", "A=a"),
        make("http://www.host.test/some/paths", ""),
        make("http://www.host.test/some/path/foo", "A=a"),
        make("http://www.host.test/some/path/foo/", "A=a"),
      ],
    ),
    new jarTest(
      "Implicit path #3: no path in URL at all.",
      "http://www.host.test",
      ["A=a"],
      "A=a",
      [
        make("http://www.host.test", "A=a"),
        make("http://www.host.test/", "A=a"),
        make("http://www.host.test/some/path", "A=a"),
      ],
    ),
    new jarTest(
      "Cookies are sorted by path length.",
      "http://www.host.test/",
      [
        "A=a; path=/foo/bar",
        "B=b; path=/foo/bar/baz/qux",
        "C=c; path=/foo/bar/baz",
        "D=d; path=/foo",
      ],
      "A=a B=b C=c D=d",
      [
        make("http://www.host.test/foo/bar/baz/qux", "B=b C=c A=a D=d"),
        make("http://www.host.test/foo/bar/baz/", "C=c A=a D=d"),
        make("http://www.host.test/foo/bar", "A=a D=d"),
      ],
    ),
    new jarTest(
      "Creation time determines sorting on same length paths.",
      "http://www.host.test/",
      [
        "A=a; path=/foo/bar",
        "X=x; path=/foo/bar",
        "Y=y; path=/foo/bar/baz/qux",
        "B=b; path=/foo/bar/baz/qux",
        "C=c; path=/foo/bar/baz",
        "W=w; path=/foo/bar/baz",
        "Z=z; path=/foo",
        "D=d; path=/foo",
      ],
      "A=a B=b C=c D=d W=w X=x Y=y Z=z",
      [
        make(
          "http://www.host.test/foo/bar/baz/qux",
          "Y=y B=b C=c W=w A=a X=x Z=z D=d",
        ),
        make("http://www.host.test/foo/bar/baz/", "C=c W=w A=a X=x Z=z D=d"),
        make("http://www.host.test/foo/bar", "A=a X=x Z=z D=d"),
      ],
    ),
    new jarTest(
      "Sorting of same-name cookies.",
      "http://www.host.test/",
      [
        "A=1; path=/",
        "A=2; path=/path",
        "A=3; path=/quux",
        "A=4; path=/path/foo",
        "A=5; domain=.host.test; path=/path",
        "A=6; domain=.host.test; path=/quux",
        "A=7; domain=.host.test; path=/path/foo",
      ],
      "A=1 A=2 A=3 A=4 A=5 A=6 A=7",
      [
        make("http://www.host.test/path", "A=2 A=5 A=1"),
        make("http://www.host.test/path/foo", "A=4 A=7 A=2 A=5 A=1"),
      ],
    ),
    new jarTest(
      "Disallow domain cookie on public suffix.",
      "http://www.bbc.co.uk",
      ["a=1", "b=2; domain=co.uk"],
      "a=1",
      [make("http://www.bbc.co.uk", "a=1")],
    ),
    new jarTest(
      "Host cookie on IP.",
      "http://192.168.0.10",
      ["a=1"],
      "a=1",
      [make("http://192.168.0.10", "a=1")],
    ),
    new jarTest(
      "Port is ignored #1.",
      "http://www.host.test/",
      ["a=1"],
      "a=1",
      [
        make("http://www.host.test", "a=1"),
        make("http://www.host.test:8080/", "a=1"),
      ],
    ),
    new jarTest(
      "Port is ignored #2.",
      "http://www.host.test:8080/",
      ["a=1"],
      "a=1",
      [
        make("http://www.host.test", "a=1"),
        make("http://www.host.test:8080/", "a=1"),
        make("http://www.host.test:1234/", "a=1"),
      ],
    ),
  ];
  for (const test of tests) {
    const jar = newTestJar();
    test.run(jar);
  }
});
Deno.test("UpdateAndDelete", () => {
  const tests: Array<jarTest> = [
    new jarTest(
      "Set initial cookies.",
      "http://www.host.test",
      [
        "a=1",
        "b=2; secure",
        "c=3; httponly",
        "d=4; secure; httponly",
      ],
      "a=1 b=2 c=3 d=4",
      [
        make("http://www.host.test", "a=1 c=3"),
        make("https://www.host.test", "a=1 b=2 c=3 d=4"),
      ],
    ),
    new jarTest(
      "Update value via http.",
      "http://www.host.test",
      [
        "a=w",
        "b=x; secure",
        "c=y; httponly",
        "d=z; secure; httponly",
      ],
      "a=w b=x c=y d=z",
      [
        make("http://www.host.test", "a=w c=y"),
        make("https://www.host.test", "a=w b=x c=y d=z"),
      ],
    ),
    new jarTest(
      "Clear Secure flag from a http.",
      "http://www.host.test/",
      [
        "b=xx",
        "d=zz; httponly",
      ],
      "a=w b=xx c=y d=zz",
      [make("http://www.host.test", "a=w b=xx c=y d=zz")],
    ),
    new jarTest(
      "Delete all.",
      "http://www.host.test/",
      [
        "a=1; max-Age=-1", // delete via MaxAge
        "b=2; " + expiresIn(-10), // delete via Expires
        "c=2; max-age=-1; " + expiresIn(-10), // delete via both
        "d=4; max-age=-1; " + expiresIn(10),
      ], // MaxAge takes precedence
      "",
      [make("http://www.host.test", "")],
    ),
    new jarTest(
      "Refill #1.",
      "http://www.host.test",
      [
        "A=1",
        "A=2; path=/foo",
        "A=3; domain=.host.test",
        "A=4; path=/foo; domain=.host.test",
      ],
      "A=1 A=2 A=3 A=4",
      [make("http://www.host.test/foo", "A=2 A=4 A=1 A=3")],
    ),
    new jarTest(
      "Refill #2.",
      "http://www.google.com",
      [
        "A=6",
        "A=7; path=/foo",
        "A=8; domain=.google.com",
        "A=9; path=/foo; domain=.google.com",
      ],
      "A=1 A=2 A=3 A=4 A=6 A=7 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=4 A=1 A=3"),
        make("http://www.google.com/foo", "A=7 A=9 A=6 A=8"),
      ],
    ),
    new jarTest(
      "Delete A7.",
      "http://www.google.com",
      ["A=; path=/foo; max-age=-1"],
      "A=1 A=2 A=3 A=4 A=6 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=4 A=1 A=3"),
        make("http://www.google.com/foo", "A=9 A=6 A=8"),
      ],
    ),
    new jarTest(
      "Delete A4.",
      "http://www.host.test",
      ["A=; path=/foo; domain=host.test; max-age=-1"],
      "A=1 A=2 A=3 A=6 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=1 A=3"),
        make("http://www.google.com/foo", "A=9 A=6 A=8"),
      ],
    ),
    new jarTest(
      "Delete A6.",
      "http://www.google.com",
      ["A=; max-age=-1"],
      "A=1 A=2 A=3 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=1 A=3"),
        make("http://www.google.com/foo", "A=9 A=8"),
      ],
    ),
    new jarTest(
      "Delete A3.",
      "http://www.host.test",
      ["A=; domain=host.test; max-age=-1"],
      "A=1 A=2 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=1"),
        make("http://www.google.com/foo", "A=9 A=8"),
      ],
    ),
    new jarTest(
      "No cross-domain delete.",
      "http://www.host.test",
      [
        "A=; domain=google.com; max-age=-1",
        "A=; path=/foo; domain=google.com; max-age=-1",
      ],
      "A=1 A=2 A=8 A=9",
      [
        make("http://www.host.test/foo", "A=2 A=1"),
        make("http://www.google.com/foo", "A=9 A=8"),
      ],
    ),
    new jarTest(
      "Delete A8 and A9.",
      "http://www.google.com",
      [
        "A=; domain=google.com; max-age=-1",
        "A=; path=/foo; domain=google.com; max-age=-1",
      ],
      "A=1 A=2",
      [
        make("http://www.host.test/foo", "A=2 A=1"),
        make("http://www.google.com/foo", ""),
      ],
    ),
  ];
  const jar = newTestJar();
  for (const test of tests) {
    test.run(jar);
  }
});
