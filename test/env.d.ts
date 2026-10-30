declare namespace Cloudflare {
  type MainModuleEnv = import("../src/index").Env;
  interface GlobalProps {
    mainModule: typeof import("../src/index");
    durableNamespaces: "Mailbox";
  }
  interface Env extends MainModuleEnv {}
}
