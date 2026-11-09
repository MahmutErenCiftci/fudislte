"""Agents: a bounded tool-using loop whose tools act only through the FUDISLTE API.

Destructive tools never run inside the loop: the run pauses for a person's approval of
that exact call (tool + canonical arguments, bound by a SHA-256 hash).
"""
