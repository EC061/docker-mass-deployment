# Default lab base image: an SSH-accessible Ubuntu with sudo + Python.
#
# Students are added later as Linux users by the agent (docker exec useradd ...), so this image does
# NOT create users at boot. The agent bind-mounts lab data at /labdata/{fast,slow} and per-student
# datasets under /labusers/{fast,slow}; the agent wires each student's ~/scratch and ~/cold-storage.
#
# Build + tag for use as a lab image:
#   docker build -t custom-ssh ./image

# Pinned by digest for reproducible builds (M-09); Dependabot bumps it, the tag comment stays readable.
FROM ubuntu:noble@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server sudo python3-pip python3-venv curl nano ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    # Harden sshd: students authenticate with passwords, but root login is off, brute force is
    # throttled, and the login window is short (H-05). Instructors can still use key auth.
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nMaxAuthTries 3\nLoginGraceTime 30\n' >> /etc/ssh/sshd_config \
    # Lock the root account password so it cannot be used for SSH/su.
    && passwd -l root \
    && mkdir -p /var/run/sshd /labdata /labusers

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D", "-e"]
