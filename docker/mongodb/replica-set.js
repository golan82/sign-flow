// Bootstrap and readiness probe for the single-node replica set.
// Safe to run repeatedly: initiates rs0 only when it is not initialized yet,
// then exits non-zero until this node is PRIMARY.
//
// The member address is what drivers switch to after replica set discovery,
// so it must be reachable by the clients of each setup:
//   - local development (compose.dev.yaml): 127.0.0.1:27017, reachable from
//     the Windows host through the published port (the default);
//   - full Docker run (docker-compose.yml): mongodb:27017, the service name
//     on the Compose network (set through MONGO_REPLICA_HOST).
// Each setup has its own volumes. If an existing replica set was initiated
// with a different address, this script does NOT reconfigure it: it reports
// the mismatch and stays unhealthy.

const REPLICA_SET = "rs0";
const MEMBER_HOST = process.env.MONGO_REPLICA_HOST || "127.0.0.1:27017";

let initialized = true;
try {
  rs.status();
} catch (error) {
  if (error.codeName !== "NotYetInitialized") {
    throw error;
  }
  initialized = false;
  rs.initiate({ _id: REPLICA_SET, members: [{ _id: 0, host: MEMBER_HOST }] });
  print(`Initiated replica set ${REPLICA_SET} with member ${MEMBER_HOST}`);
}

if (initialized) {
  const hosts = rs.conf().members.map((member) => member.host);
  if (!hosts.includes(MEMBER_HOST)) {
    print(
      `Replica set ${REPLICA_SET} in this volume uses ${hosts.join(", ")}, expected ${MEMBER_HOST}. ` +
        "Not reconfiguring automatically; use the volume that belongs to this setup.",
    );
    quit(2);
  }
}

const hello = db.hello();
if (!hello.isWritablePrimary) {
  print(`Replica set ${REPLICA_SET} has no PRIMARY yet`);
  quit(1);
}
